import type { WebSocket } from 'ws';
import type { Db } from '../db/pool.js';
import type { AlarmChange } from './alarm-engine.js';
import type { SessionService } from './sessions.js';
import { scopeFor } from './scope.js';
import type { Role } from '@firesafety/shared';

type ScopedUser = { id: string; roles: Role[] };

interface Client {
  ws: WebSocket;
  userId: string;
  sessionToken: string;
  buildings: Set<string> | 'all';
}

/**
 * Pushes "something changed" notifications to connected browsers.
 * Messages carry only categories, never alarm content: clients re-fetch through
 * the scoped REST API, so a filtering bug here cannot leak data across buildings.
 */
export class RealtimeHub {
  private clients = new Set<Client>();

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  async add(ws: WebSocket, user: ScopedUser, sessionToken: string): Promise<void> {
    const client: Client = { ws, userId: user.id, sessionToken, buildings: await this.loadScope(user) };
    this.clients.add(client);
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
    this.send(client, { type: 'hello' });
  }

  notify(changes: AlarmChange[]): void {
    if (changes.length === 0) return;
    for (const client of this.clients) {
      const relevant = changes.filter(
        (ch) => client.buildings === 'all' || (ch.buildingId !== null && client.buildings.has(ch.buildingId)),
      );
      if (relevant.length > 0) {
        this.send(client, { type: 'alarms', categories: [...new Set(relevant.map((r) => r.category))] });
      }
    }
    if (changes.some((c) => c.kind !== 'point')) this.broadcast({ type: 'status' });
  }

  broadcast(msg: object): void {
    for (const client of this.clients) this.send(client, msg);
  }

  /** Re-validates sessions and reloads scopes; closes sockets whose session ended. */
  async refresh(): Promise<void> {
    for (const client of [...this.clients]) {
      const user = await this.sessions.resolve(client.sessionToken).catch(() => null);
      if (!user || user.id !== client.userId) {
        client.ws.close(4401, 'session ended');
        this.clients.delete(client);
        continue;
      }
      client.buildings = await this.loadScope(user);
    }
  }

  closeAll(): void {
    for (const client of this.clients) client.ws.close(1001, 'server shutdown');
    this.clients.clear();
  }

  private async loadScope(user: ScopedUser): Promise<Set<string> | 'all'> {
    const scope = scopeFor(user);
    if (scope.kind === 'all') return 'all';
    const { rows } = await this.db.query<{ building_id: string }>('SELECT building_id FROM user_building_scope WHERE user_id = $1', [user.id]);
    return new Set(rows.map((r) => r.building_id));
  }

  private send(client: Client, msg: object): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }
}
