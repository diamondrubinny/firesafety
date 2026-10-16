import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { CATEGORY_LABELS_HE, reportQuerySchema, type PointCategory } from '@firesafety/shared';
import { requireRole, requireUser } from '../auth/guards.js';
import { toCsv } from '../lib/csv-export.js';
import { parse } from '../lib/errors.js';
import { scopeFor } from '../services/scope.js';

const fmt = new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'medium' });
const when = (iso: string | null) => (iso ? fmt.format(new Date(iso)) : '');
const label = (c: string) => CATEGORY_LABELS_HE[c as PointCategory] ?? c;

function sendCsv(reply: FastifyReply, name: string, csv: string) {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${name}"`)
    .header('Cache-Control', 'no-store')
    .send(csv);
}

export const reportRoutes: FastifyPluginAsync = async (app) => {
  const { services } = app;
  app.addHook('preHandler', requireRole('SafetyOfficer', 'FireAdmin'));

  app.get('/reports/alarms', async (req) => {
    const q = parse(reportQuerySchema, req.query);
    return services.reports.alarms(scopeFor(requireUser(req)), q, 500);
  });

  app.get('/reports/alarms.csv', async (req, reply) => {
    const user = requireUser(req);
    const q = parse(reportQuerySchema, req.query);
    const rows = await services.reports.alarmRows(scopeFor(user), q, 50_000);
    await services.audit.write({ userId: user.id, action: 'report.export', entity: 'report', entityId: 'alarms', outcome: 'success', ipHash: req.ipHash, details: { ...q, rows: rows.length } });
    const csv = toCsv(
      ['התחלה', 'סיום', 'סוג', 'מבנה', 'נקודה / תיאור', 'מיקום', 'אישור קבלה', 'אושר על ידי', 'זמן עד אישור (שניות)'],
      rows.map((r) => [when(r.raisedAt), when(r.clearedAt), r.kind === 'point' ? label(r.category) : 'תקלת תקשורת', r.buildingName, r.pointLabel, r.location, when(r.ackedAt), r.ackedBy, r.ackSeconds]),
    );
    return sendCsv(reply, `alarms-${q.from}-${q.to}.csv`, csv);
  });

  app.get('/reports/open-issues', async (req) => services.reports.openIssues(scopeFor(requireUser(req))));

  app.get('/reports/open-issues.csv', async (req, reply) => {
    const user = requireUser(req);
    const rows = await services.reports.openIssues(scopeFor(user));
    await services.audit.write({ userId: user.id, action: 'report.export', entity: 'report', entityId: 'open-issues', outcome: 'success', ipHash: req.ipHash, details: { rows: rows.length } });
    const csv = toCsv(['מצב', 'מבנה', 'נקודה', 'מיקום', 'מאז'], rows.map((r) => [label(r.category), r.buildingName, r.pointLabel, r.location, when(r.since)]));
    return sendCsv(reply, `open-issues-${new Date().toISOString().slice(0, 10)}.csv`, csv);
  });
};
