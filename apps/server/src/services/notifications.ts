import type { FastifyBaseLogger } from 'fastify';
import {
  CATEGORY_LABELS_HE,
  maskPhone,
  type AlarmCategory,
  type Channel,
  type NotificationLogEntry,
  type NotificationSettings,
  type Page,
} from '@firesafety/shared';
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { ContactService } from './contacts.js';
import type { SettingsService, ResolvedSettings } from './settings.js';
import { sendEmail } from './providers/email.js';
import { isAllowedPushEndpoint, sendPush, SubscriptionGone } from './providers/push.js';
import { sendSms } from './providers/sms.js';
import { ProviderError, type OutboundMessage } from './providers/types.js';
import { sendWhatsApp } from './providers/whatsapp.js';

export interface NotificationOptions {
  publicOrigin: string;
  twilioBase: string;
  whatsappBase: string;
  allowInsecure: boolean;
  pushAllowlist: string[];
}

const MAX_ATTEMPTS = 5;
const BACKOFF_SECONDS = [5, 15, 60, 300];
const TZ = 'Asia/Jerusalem';
const timeFmt = new Intl.DateTimeFormat('he-IL', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

interface AlarmInfo {
  id: string;
  kind: 'point' | 'device_comm' | 'collector_comm';
  category: AlarmCategory;
  raised_at: Date;
  cleared_at: Date | null;
  acked_at: Date | null;
  building_id: string | null;
  building_name: string | null;
  floor_name: string | null;
  point_label: string | null;
  message: string | null;
}

const ALARM_INFO_SQL = `
  SELECT a.id, a.kind, a.category, a.raised_at, a.cleared_at, a.acked_at, a.message,
         b.id AS building_id, b.name AS building_name, f.name AS floor_name,
         COALESCE(p.label, p.name, p.object_type || ':' || p.object_instance) AS point_label
    FROM alarm a
    LEFT JOIN point p ON p.id = a.point_id
    LEFT JOIN bacnet_device d ON d.id = COALESCE(a.device_id, p.device_id)
    LEFT JOIN building b ON b.id = COALESCE(p.building_id, d.building_id)
    LEFT JOIN floor f ON f.id = p.floor_id`;

/**
 * Notification pipeline, fully database-driven so it survives restarts:
 *   plan()     new alarms → one row per (alarm, user, channel) in the notification outbox
 *   escalate() unacknowledged fire alarms → escalation rows
 *   process()  claims due rows, groups them per (user, channel), sends, retries with backoff
 */
export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly contacts: ContactService,
    private readonly opts: NotificationOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  async runOnce(): Promise<void> {
    await this.plan();
    await this.escalate();
    await this.process();
  }

  // ---------------------------------------------------------------- planning

  async plan(): Promise<number> {
    const resolved = await this.settings.get();
    return withTransaction(this.db, async (c) => {
      const { rows: alarms } = await c.query<AlarmInfo>(
        `${ALARM_INFO_SQL}
          WHERE a.id IN (SELECT id FROM alarm WHERE notified_at IS NULL ORDER BY received_at LIMIT 200 FOR UPDATE SKIP LOCKED)`,
      );
      let planned = 0;
      for (const a of alarms) {
        const channels = resolved.settings.enabled ? this.policyChannels(resolved.settings, a) : [];
        // Transient non-fire states that already cleared are not worth waking people for.
        if (channels.length > 0 && !(a.cleared_at && a.category !== 'fire')) {
          const recipients = await this.recipients(c, a);
          planned += await this.enqueue(c, a.id, recipients, channels, 'initial');
        }
        await c.query('UPDATE alarm SET notified_at = now() WHERE id = $1', [a.id]);
      }
      return planned;
    });
  }

  private policyChannels(s: NotificationSettings, a: AlarmInfo): Channel[] {
    const list = a.kind === 'point' ? (a.category === 'fire' || a.category === 'prealarm' || a.category === 'fault' ? s.policy[a.category] : []) : s.policy.comm;
    return list.filter((ch) => s[ch].enabled);
  }

  /** Safety officers / admins whose building scope covers the alarm. Communication alarms go to admins only. */
  private async recipients(c: pg.PoolClient, a: AlarmInfo): Promise<string[]> {
    const { rows } = await c.query<{ id: string }>(
      `SELECT u.id FROM app_user u
        WHERE u.active AND (
          'FireAdmin' = ANY(u.roles)
          OR ($1::text = 'point' AND 'SafetyOfficer' = ANY(u.roles)
              AND EXISTS (SELECT 1 FROM user_building_scope s WHERE s.user_id = u.id AND s.building_id = $2)))`,
      [a.kind, a.building_id],
    );
    return rows.map((r) => r.id);
  }

  private async enqueue(
    c: pg.PoolClient,
    alarmId: string,
    userIds: string[],
    channels: Channel[],
    stage: 'initial' | 'escalation',
  ): Promise<number> {
    let n = 0;
    for (const userId of userIds) {
      const contact = await this.contacts.get(userId);
      const pushCount = channels.includes('push')
        ? Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM push_subscription WHERE user_id = $1', [userId])).rows[0]?.n ?? 0)
        : 0;
      for (const ch of channels) {
        if (!contact.channels.includes(ch)) continue; // user opted out of this channel
        const missing =
          ch === 'push' ? (pushCount === 0 ? 'אין מכשיר רשום ל-Push' : null)
          : ch === 'email' ? (contact.email ? null : 'אין כתובת דוא"ל')
          : ch === 'sms' ? (contact.phone ? null : 'לא הוגדר מספר טלפון')
          : !contact.phone ? 'לא הוגדר מספר טלפון'
          : !contact.whatsappOptIn ? 'המשתמש לא אישר קבלת WhatsApp'
          : null;
        const r = await c.query(
          `INSERT INTO notification (alarm_id, user_id, channel, stage, status, last_error)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
          [alarmId, userId, ch, stage, missing ? 'skipped' : 'pending', missing],
        );
        if (!missing) n += r.rowCount ?? 0;
      }
    }
    return n;
  }

  // -------------------------------------------------------------- escalation

  async escalate(): Promise<number> {
    const resolved = await this.settings.get();
    const s = resolved.settings;
    if (!s.enabled) return 0;
    const channels = s.policy.escalationChannels.filter((ch) => s[ch].enabled);
    return withTransaction(this.db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM alarm
          WHERE category = 'fire' AND cleared_at IS NULL AND acked_at IS NULL AND escalated_at IS NULL
            AND notified_at IS NOT NULL AND received_at < now() - make_interval(secs => $1)
          FOR UPDATE SKIP LOCKED LIMIT 100`,
        [s.policy.escalationSeconds],
      );
      let n = 0;
      for (const { id } of rows) {
        const { rows: users } = await c.query<{ id: string }>(
          `SELECT DISTINCT user_id AS id FROM notification WHERE alarm_id = $1
           UNION SELECT id FROM app_user WHERE active AND 'FireAdmin' = ANY(roles)`,
          [id],
        );
        if (channels.length > 0) n += await this.enqueue(c, id, users.map((u) => u.id), channels, 'escalation');
        await c.query('UPDATE alarm SET escalated_at = now() WHERE id = $1', [id]);
      }
      return n;
    });
  }

  // ---------------------------------------------------------------- delivery

  async process(): Promise<number> {
    const resolved = await this.settings.get();
    // Recover rows claimed by a crashed worker.
    await this.db.query(`UPDATE notification SET status = 'pending' WHERE status = 'sending' AND claimed_at < now() - interval '2 minutes'`);
    const { rows: claimed } = await this.db.query<{ id: string; alarm_id: string; user_id: string; channel: Channel; stage: 'initial' | 'escalation'; attempts: number }>(
      `UPDATE notification SET status = 'sending', claimed_at = now(), attempts = attempts + 1
        WHERE id IN (SELECT id FROM notification WHERE status = 'pending' AND next_attempt_at <= now()
                      ORDER BY created_at LIMIT 300 FOR UPDATE SKIP LOCKED)
        RETURNING id, alarm_id, user_id, channel, stage, attempts`,
    );
    if (claimed.length === 0) return 0;

    // Group per (user, channel, stage) so a burst of alarms becomes one message.
    const groups = new Map<string, typeof claimed>();
    for (const r of claimed) {
      const k = `${r.user_id}|${r.channel}|${r.stage}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    let sent = 0;
    for (const rows of groups.values()) {
      const { user_id: userId, channel, stage } = rows[0]!;
      const ids = rows.map((r) => r.id);

      // Rate limit per user/channel: within the grouping window, defer and merge.
      if (stage === 'initial' && resolved.settings.policy.groupingSeconds > 0) {
        const { rows: last } = await this.db.query<{ until: Date }>(
          `SELECT max(sent_at) + make_interval(secs => $3) AS until FROM notification
            WHERE user_id = $1 AND channel = $2 AND status = 'sent' AND stage = 'initial'
           HAVING max(sent_at) > now() - make_interval(secs => $3)`,
          [userId, channel, resolved.settings.policy.groupingSeconds],
        );
        if (last[0]) {
          await this.db.query(`UPDATE notification SET status = 'pending', attempts = attempts - 1, next_attempt_at = $2 WHERE id = ANY($1::uuid[])`, [ids, last[0].until]);
          continue;
        }
      }

      const { rows: alarms } = await this.db.query<AlarmInfo>(`${ALARM_INFO_SQL} WHERE a.id = ANY($1::uuid[])`, [rows.map((r) => r.alarm_id)]);
      const relevant = alarms.filter((a) => !a.acked_at && !(a.cleared_at && a.category !== 'fire'));
      const relevantIds = new Set(relevant.map((a) => a.id));
      const skip = rows.filter((r) => !relevantIds.has(r.alarm_id)).map((r) => r.id);
      if (skip.length) await this.markSkipped(skip, 'האירוע כבר אושר או הסתיים');
      const toSend = rows.filter((r) => relevantIds.has(r.alarm_id));
      if (toSend.length === 0) continue;

      const msg = this.buildMessage(relevant, stage);
      try {
        const hint = await this.deliver(resolved, userId, channel, msg);
        await this.db.query(
          `UPDATE notification SET status = 'sent', sent_at = now(), recipient_hint = $2, last_error = NULL WHERE id = ANY($1::uuid[])`,
          [toSend.map((r) => r.id), hint],
        );
        sent += toSend.length;
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('unexpected error', true);
        if (!(err instanceof ProviderError)) this.log.error({ err, channel }, 'notification delivery crashed');
        const attempts = toSend[0]!.attempts;
        const giveUp = !pe.retryable || attempts >= MAX_ATTEMPTS;
        await this.db.query(
          `UPDATE notification SET status = $2, last_error = $3,
                  next_attempt_at = now() + make_interval(secs => $4)
            WHERE id = ANY($1::uuid[])`,
          [toSend.map((r) => r.id), giveUp ? 'failed' : 'pending', pe.message.slice(0, 300), BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]],
        );
        this.log.warn({ channel, attempts, giveUp, reason: pe.message }, 'notification delivery failed');
      }
    }
    return sent;
  }

  private async markSkipped(ids: string[], reason: string): Promise<void> {
    await this.db.query(`UPDATE notification SET status = 'skipped', last_error = $2 WHERE id = ANY($1::uuid[])`, [ids, reason]);
  }

  /** Sends one message to one user on one channel. Returns a masked recipient hint. */
  private async deliver(resolved: ResolvedSettings, userId: string, channel: Channel, msg: OutboundMessage): Promise<string> {
    const { settings: s, secrets } = resolved;
    const contact = await this.contacts.get(userId);
    switch (channel) {
      case 'email':
        await sendEmail(s.email, secrets.emailPassword, contact.email, msg, this.opts.allowInsecure);
        return contact.email.replace(/^(.).*(@.*)$/, '$1•••$2');
      case 'sms':
        if (!contact.phone) throw new ProviderError('no phone number', false);
        await sendSms(s.sms, secrets, contact.phone, `${msg.text}\n${msg.url}`, { twilioBase: this.opts.twilioBase, allowInsecure: this.opts.allowInsecure });
        return maskPhone(contact.phone);
      case 'whatsapp':
        if (!contact.phone || !contact.whatsappOptIn) throw new ProviderError('no WhatsApp consent or phone', false);
        await sendWhatsApp(s.whatsapp, secrets.whatsappAccessToken, contact.phone, msg.text, msg.url, this.opts.whatsappBase);
        return maskPhone(contact.phone);
      case 'push': {
        if (!resolved.vapidPublicKey || !secrets.vapidPrivateKey) throw new ProviderError('push keys not initialised', false);
        const subs = await this.contacts.pushSubscriptions(userId);
        let ok = 0;
        let lastErr: ProviderError | null = null;
        for (const sub of subs) {
          if (!isAllowedPushEndpoint(sub.endpoint, this.opts.pushAllowlist, this.opts.allowInsecure)) {
            await this.contacts.deletePushSubscription(sub.id);
            continue;
          }
          try {
            await sendPush(sub, msg, { subject: s.push.subject, publicKey: resolved.vapidPublicKey, privateKey: secrets.vapidPrivateKey });
            ok++;
          } catch (err) {
            if (err instanceof SubscriptionGone) await this.contacts.deletePushSubscription(sub.id);
            else lastErr = err instanceof ProviderError ? err : new ProviderError('push failed', true);
          }
        }
        if (ok === 0) throw lastErr ?? new ProviderError('no active push subscription', false);
        return `${ok} מכשירים`;
      }
    }
  }

  buildMessage(alarms: Pick<AlarmInfo, 'id' | 'kind' | 'category' | 'raised_at' | 'building_name' | 'floor_name' | 'point_label' | 'message'>[], stage: 'initial' | 'escalation'): OutboundMessage {
    const prefix = stage === 'escalation' ? 'הסלמה: טרם אושר! ' : '';
    const urgent = alarms.some((a) => a.category === 'fire');
    if (alarms.length === 1) {
      const a = alarms[0]!;
      const what = a.kind === 'point' ? CATEGORY_LABELS_HE[a.category] : 'תקלת תקשורת';
      const parts = [what, a.building_name ?? 'מבנה לא משויך', a.floor_name, a.kind === 'point' ? a.point_label : a.message, timeFmt.format(a.raised_at)].filter(Boolean);
      return {
        title: `${prefix}${what}${a.building_name ? `: ${a.building_name}` : ''}`,
        text: `${prefix}${parts.join(' | ')}`,
        url: `${this.opts.publicOrigin}/alarms/${a.id}`,
        urgent,
      };
    }
    const counts = new Map<string, number>();
    for (const a of alarms) {
      const k = `${a.kind === 'point' ? CATEGORY_LABELS_HE[a.category] : 'תקלת תקשורת'} ב${a.building_name ?? 'מבנה לא משויך'}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const summary = [...counts].map(([k, n]) => `${k} (${n})`).join(', ');
    return {
      title: `${prefix}${alarms.length} התרעות${urgent ? ', כולל אש' : ''}`,
      text: `${prefix}${alarms.length} התרעות: ${summary}`,
      url: `${this.opts.publicOrigin}/`,
      urgent,
    };
  }

  // ------------------------------------------------------------------- tests

  /** Admin test: sends immediately (not through the outbox) to the given address or the admin's own devices. */
  async sendTest(channel: Channel, to: string | undefined, userId: string): Promise<string> {
    const resolved = await this.settings.get();
    const msg: OutboundMessage = { title: 'בדיקת התראה', text: 'בדיקת התראה ממערכת ניטור האש. אין צורך בפעולה.', url: `${this.opts.publicOrigin}/`, urgent: false };
    const { settings: s, secrets } = resolved;
    if (channel === 'push') return this.deliver(resolved, userId, 'push', msg);
    if (!to) throw new ProviderError('recipient is required', false);
    if (channel === 'email') {
      await sendEmail(s.email, secrets.emailPassword, to, msg, this.opts.allowInsecure);
      return to.replace(/^(.).*(@.*)$/, '$1•••$2');
    }
    if (channel === 'sms') {
      await sendSms(s.sms, secrets, to, `${msg.text}\n${msg.url}`, { twilioBase: this.opts.twilioBase, allowInsecure: this.opts.allowInsecure });
      return maskPhone(to);
    }
    await sendWhatsApp(s.whatsapp, secrets.whatsappAccessToken, to, msg.text, msg.url, this.opts.whatsappBase);
    return maskPhone(to);
  }

  /** Delivers a phone-verification code by SMS, or WhatsApp when SMS is not configured. */
  async sendVerificationCode(phone: string, code: string): Promise<'sms' | 'whatsapp'> {
    const { settings: s, secrets } = await this.settings.get();
    const text = `קוד אימות למערכת ניטור האש: ${code}. הקוד תקף ל-10 דקות. אם לא ביקשת אותו, אפשר להתעלם.`;
    if (s.enabled && s.sms.enabled) {
      await sendSms(s.sms, secrets, phone, text, { twilioBase: this.opts.twilioBase, allowInsecure: this.opts.allowInsecure });
      return 'sms';
    }
    if (s.enabled && s.whatsapp.enabled) {
      await sendWhatsApp(s.whatsapp, secrets.whatsappAccessToken, phone, `קוד אימות: ${code}`, this.opts.publicOrigin, this.opts.whatsappBase);
      return 'whatsapp';
    }
    throw new ProviderError('no SMS or WhatsApp channel is configured', false);
  }

  /** User self-test on every channel they can currently receive. */
  async sendSelfTest(userId: string): Promise<Record<string, string>> {
    const resolved = await this.settings.get();
    const contact = await this.contacts.get(userId);
    const msg: OutboundMessage = { title: 'בדיקת התראה', text: 'בדיקת התראה אישית ממערכת ניטור האש.', url: `${this.opts.publicOrigin}/`, urgent: false };
    const out: Record<string, string> = {};
    for (const ch of contact.channels) {
      if (!resolved.settings.enabled || !resolved.settings[ch].enabled) continue;
      try {
        out[ch] = `נשלח (${await this.deliver(resolved, userId, ch, msg)})`;
      } catch (err) {
        out[ch] = `נכשל: ${err instanceof ProviderError ? err.message : 'שגיאה'}`;
      }
    }
    return out;
  }

  async deliveryLog(limit: number, offset: number): Promise<Page<NotificationLogEntry>> {
    const [items, total] = await Promise.all([
      this.db.query(
        `SELECT n.id, n.created_at, n.sent_at, n.alarm_id, u.display_name, n.channel, n.stage, n.status, n.attempts, n.recipient_hint, n.last_error
           FROM notification n JOIN app_user u ON u.id = n.user_id
          ORDER BY n.created_at DESC, n.id LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      this.db.query<{ count: string }>('SELECT count(*) FROM notification'),
    ]);
    return {
      items: items.rows.map((r) => ({
        id: r.id,
        createdAt: (r.created_at as Date).toISOString(),
        sentAt: r.sent_at ? (r.sent_at as Date).toISOString() : null,
        alarmId: r.alarm_id,
        userName: r.display_name,
        channel: r.channel,
        stage: r.stage,
        status: r.status,
        attempts: r.attempts,
        recipientHint: r.recipient_hint,
        lastError: r.last_error,
      })),
      total: Number(total.rows[0]?.count ?? 0),
    };
  }
}
