/**
 * Fila "Digitalizacoes" — API_CONTRACTS §15.2 (`POST /capture/scans`), §15.3,
 * §15.4 e `scanId` em `POST /conversations/:id/attachments` (CRMLAB-184, D-327).
 */
import { existsSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PENDING_SCANS_PER_DEVICE, MAX_SCAN_BYTES } from '@crm-lab/shared';
import { captureModule } from '../../src/controllers/capture.routes.js';
import { conversationModule } from '../../src/controllers/conversation.routes.js';
import { mediaModule } from '../../src/controllers/media.routes.js';
import { scanModule } from '../../src/controllers/scan.routes.js';
import type { DbClient } from '../../src/db/types.js';
import { CAPTURE_COOKIE_NAME } from '../../src/lib/cookies.js';
import { scanFilePath } from '../../src/lib/media-storage.js';
import { createAuditService } from '../../src/services/audit.service.js';
import { ScanService, scanFileName } from '../../src/services/scan.service.js';
import {
  createConversation,
  createTenant,
  createUser,
  type TenantRecord,
  type UserRecord,
} from '../helpers/factories.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';
import { getTestDb, resetDatabase } from '../helpers/test-db.js';
import {
  ALLOWED_ORIGIN,
  auditActions,
  jpegBase64,
  jpegBuffer,
  pngBuffer,
  scanCount,
  seedPairedDevice,
  seedScan,
} from './helpers.js';

describe('Digitalizacoes', () => {
  let db: DbClient;
  let app: TestApp;
  let tenant: TenantRecord;
  let admin: UserRecord;
  let manager: UserRecord;
  let attendant: UserRecord;
  let device: { id: string; cookie: string };

  beforeAll(async () => {
    db = await getTestDb();
  });

  beforeEach(async () => {
    await resetDatabase(db);
    app = await createTestApp({ db, modules: [captureModule, scanModule, conversationModule, mediaModule] });
    tenant = await createTenant({ db });
    admin = await createUser({ tenantId: tenant.id, role: 'admin', db });
    manager = await createUser({ tenantId: tenant.id, role: 'manager', db });
    attendant = await createUser({ tenantId: tenant.id, role: 'attendant', db });
    device = await seedPairedDevice(db, tenant.id, 'Celular recepcao');
  });

  function upload(body: Record<string, unknown>, cookie = device.cookie, origin: string | null = ALLOWED_ORIGIN) {
    const req = app.agent.post('/api/v1/capture/scans').set('Cookie', cookie);
    return (origin === null ? req : req.set('Origin', origin)).send(body);
  }

  describe('POST /capture/scans', () => {
    it('JPEG vai para a fila: 201, arquivo em scans/, last_used_at e cookie renovado', async () => {
      const res = await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }).expect(201);
      expect(Object.keys(res.body).sort()).toEqual(['createdAt', 'expiresAt', 'id']);
      const ttl = new Date(res.body.expiresAt).getTime() - new Date(res.body.createdAt).getTime();
      expect(ttl).toBe(48 * 60 * 60 * 1000);
      expect(existsSync(scanFilePath(res.body.id as string))).toBe(true);
      const cookie = (res.headers['set-cookie'] as unknown as string[])[0] as string;
      expect(cookie.startsWith(`${device.cookie};`)).toBe(true);
      expect(cookie).toContain('Path=/api/v1/capture');

      const row = await db.withoutTenant((tx) =>
        tx.query<{ last_used_at: unknown }>('SELECT last_used_at FROM capture_devices WHERE id = $1', [device.id]),
      );
      expect(row.rows[0]?.last_used_at).not.toBeNull();
    });

    it('PNG vira JPEG (D-290)', async () => {
      const res = await upload({ mimeType: 'image/png', contentBase64: (await pngBuffer()).toString('base64') }).expect(201);
      const list = await app.agent.get('/api/v1/scans').set(app.auth(attendant)).expect(200);
      expect(list.body.scans[0]).toMatchObject({ id: res.body.id, mimeType: 'image/jpeg' });
      expect(list.body.scans[0].fileName).toMatch(/^digitalizacao-\d{8}-\d{6}\.jpg$/);
    });

    it('tipo fora de JPEG/PNG, ou conteudo que nao e foto: 400 e nada gravado', async () => {
      const pdf = await upload({ mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-1.4').toString('base64') }).expect(400);
      expect(pdf.body.error.details.fields).toHaveProperty('mimeType');
      const html = await upload({
        mimeType: 'image/jpeg',
        contentBase64: Buffer.from('<html><script>alert(1)</script></html>').toString('base64'),
      }).expect(400);
      expect(html.body.error.code).toBe('VALIDATION_ERROR');
      const disguised = await upload({
        mimeType: 'image/jpeg',
        contentBase64: Buffer.from('%PDF-1.4 disfarcado de foto').toString('base64'),
      }).expect(400);
      expect(disguised.body.error.code).toBe('VALIDATION_ERROR');
      expect(await scanCount(db)).toBe(0);
    });

    it('acima de 5 MB: 413 MEDIA_TOO_LARGE com byteSize e max', async () => {
      const big = Buffer.concat([await jpegBuffer(), Buffer.alloc(MAX_SCAN_BYTES)]);
      const res = await upload({ mimeType: 'image/jpeg', contentBase64: big.toString('base64') }).expect(413);
      expect(res.body.error).toMatchObject({
        code: 'MEDIA_TOO_LARGE',
        details: { byteSize: big.byteLength, max: 5242880 },
      });
    });

    it(`teto de ${MAX_PENDING_SCANS_PER_DEVICE} pendentes por dispositivo: 409 scan_queue_full (vencidas nao contam)`, async () => {
      await db.withoutTenant((tx) =>
        tx.query(
          `INSERT INTO scans (tenant_id, device_id, mime_type, byte_size, expires_at)
           SELECT $1, $2, 'image/jpeg', 10, now() + interval '1 day' FROM generate_series(1, $3::int)`,
          [tenant.id, device.id, MAX_PENDING_SCANS_PER_DEVICE - 1],
        ),
      );
      await seedScan(db, tenant.id, device.id, { expiresInHours: -1 });
      await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }).expect(201);
      const full = await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }).expect(409);
      expect(full.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'scan_queue_full', max: 100 } });
      // Outro dispositivo do mesmo laboratorio tem a propria cota.
      const other = await seedPairedDevice(db, tenant.id, 'Outro');
      await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }, other.cookie).expect(201);
    });

    it('Origin errado ou ausente: 403 antes do cookie', async () => {
      await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }, device.cookie, 'https://evil.example').expect(403);
      await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }, device.cookie, null).expect(403);
      // Sem cookie mas Origin errado: ainda 403 (Origin vem antes).
      await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }, 'x=1', 'https://evil.example').expect(403);
      expect(await scanCount(db)).toBe(0);
    });

    it('sem credencial ou revogado: 401 CAPTURE_DEVICE_UNPAIRED', async () => {
      const none = await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }, 'x=1').expect(401);
      expect(none.body.error.code).toBe('CAPTURE_DEVICE_UNPAIRED');
      await db.withoutTenant((tx) =>
        tx.query('UPDATE capture_devices SET token_hash = NULL, revoked_at = now() WHERE id = $1', [device.id]),
      );
      await upload({ mimeType: 'image/jpeg', contentBase64: await jpegBase64() }).expect(401);
    });

    it('limitador por dispositivo: cada celular tem o proprio balde', async () => {
      const first = await app.agent.get('/api/v1/capture/session').set('Cookie', device.cookie).expect(200);
      const other = await seedPairedDevice(db, tenant.id, 'Outro');
      const second = await app.agent.get('/api/v1/capture/session').set('Cookie', other.cookie).expect(200);
      expect(first.headers['x-ratelimit-remaining']).toBe(second.headers['x-ratelimit-remaining']);
    });
  });

  describe('fila /scans', () => {
    it('lista mais nova primeiro, sem vencidas, com o nome do dispositivo; todos os papeis', async () => {
      const older = await seedScan(db, tenant.id, device.id);
      await db.withoutTenant((tx) =>
        tx.query(`UPDATE scans SET created_at = now() - interval '1 hour' WHERE id = $1`, [older]),
      );
      const newer = await seedScan(db, tenant.id, device.id);
      await seedScan(db, tenant.id, device.id, { expiresInHours: -1 });

      for (const user of [attendant, manager, admin]) {
        const res = await app.agent.get('/api/v1/scans').set(app.auth(user)).expect(200);
        expect(res.body.scans.map((s: { id: string }) => s.id)).toEqual([newer, older]);
        expect(res.body.pagination).toMatchObject({ page: 1, limit: 50, total: 2 });
        expect(res.body.scans[0]).toMatchObject({
          deviceId: device.id,
          deviceName: 'Celular recepcao',
          mimeType: 'image/jpeg',
          contentUrl: `/api/v1/scans/${newer}/content`,
        });
      }
    });

    it('conteudo: bytes, Content-Type gravado, nosniff, inline com o nome; vencida e 404', async () => {
      const buffer = await jpegBuffer();
      const id = await seedScan(db, tenant.id, device.id, { buffer });
      const res = await app.agent.get(`/api/v1/scans/${id}/content`).set(app.auth(attendant)).expect(200);
      expect(Buffer.compare(res.body as Buffer, buffer)).toBe(0);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toMatch(/^inline; filename="digitalizacao-\d{8}-\d{6}\.jpg"$/);

      const expired = await seedScan(db, tenant.id, device.id, { expiresInHours: -1 });
      const gone = await app.agent.get(`/api/v1/scans/${expired}/content`).set(app.auth(attendant)).expect(404);
      expect(gone.body.error.details).toEqual({ reason: 'scan_not_found' });
    });

    it('descartar: 204, apaga linha e arquivo, audit discard_scan; de novo e 404', async () => {
      const id = await seedScan(db, tenant.id, device.id);
      await app.agent.delete(`/api/v1/scans/${id}`).set(app.auth(attendant)).expect(204);
      expect(await scanCount(db)).toBe(0);
      expect(existsSync(scanFilePath(id))).toBe(false);
      expect(await auditActions(db, 'discard_scan')).toEqual([{ user_id: attendant.id, entity_id: id }]);
      await app.agent.delete(`/api/v1/scans/${id}`).set(app.auth(attendant)).expect(404);
    });

    it(':id nao-uuid e 400; platform_operator e 403', async () => {
      await app.agent.get('/api/v1/scans/abc/content').set(app.auth(attendant)).expect(400);
      const plataforma = await createTenant({ db });
      const operator = await createUser({ tenantId: plataforma.id, role: 'platform_operator', db });
      await app.agent.get('/api/v1/scans').set(app.auth(operator)).expect(403);
    });

    it('isolamento: foto de outro laboratorio nao aparece e e 404 em conteudo, descarte e anexo', async () => {
      const other = await createTenant({ db });
      const otherDevice = await seedPairedDevice(db, other.id);
      const foreign = await seedScan(db, other.id, otherDevice.id);
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });

      const list = await app.agent.get('/api/v1/scans').set(app.auth(admin)).expect(200);
      expect(list.body.scans).toEqual([]);
      await app.agent.get(`/api/v1/scans/${foreign}/content`).set(app.auth(admin)).expect(404);
      await app.agent.delete(`/api/v1/scans/${foreign}`).set(app.auth(admin)).expect(404);
      const attach = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ scanId: foreign })
        .expect(404);
      expect(attach.body.error.details).toEqual({ reason: 'scan_not_found' });
      expect(await scanCount(db)).toBe(1);
    });
  });

  describe('anexo com scanId', () => {
    it('consome a foto: mensagem image com o nome digitalizacao-*.jpg, midia servida, foto fora da fila', async () => {
      const buffer = await jpegBuffer();
      const id = await seedScan(db, tenant.id, device.id, { buffer });
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });

      const res = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ scanId: id, caption: 'Seu pedido' })
        .expect(201);
      expect(res.body).toMatchObject({ messageType: 'image', content: 'Seu pedido' });
      const mediaId = (res.body.attachmentUrl as string).split('/').pop() as string;
      const media = await app.agent.get(`/api/v1/media/${mediaId}`).set(app.auth(attendant)).expect(200);
      expect(Buffer.compare(media.body as Buffer, buffer)).toBe(0);
      const row = await db.withoutTenant((tx) =>
        tx.query<{ file_name: string; message_id: string }>('SELECT file_name, message_id FROM message_media WHERE id = $1', [mediaId]),
      );
      expect(row.rows[0]?.file_name).toMatch(/^digitalizacao-\d{8}-\d{6}\.jpg$/);
      expect(row.rows[0]?.message_id).toBe(res.body.id);

      expect(await scanCount(db)).toBe(0);
      expect(existsSync(scanFilePath(id))).toBe(false);
      await app.agent.get(`/api/v1/scans/${id}/content`).set(app.auth(attendant)).expect(404);
    });

    it('scanId junto com o arquivo, ou nenhum dos dois: 400 sem consumir', async () => {
      const id = await seedScan(db, tenant.id, device.id);
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });
      const both = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ scanId: id, fileName: 'a.jpg', mimeType: 'image/jpeg', contentBase64: await jpegBase64() })
        .expect(400);
      expect(both.body.error.code).toBe('VALIDATION_ERROR');
      const none = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ caption: 'so legenda' })
        .expect(400);
      expect(Object.keys(none.body.error.details.fields).sort()).toEqual(['contentBase64', 'fileName', 'mimeType']);
      expect(await scanCount(db)).toBe(1);
    });

    it('recusa antes de gravar (citacao invalida) mantem a foto na fila e nao grava midia', async () => {
      const id = await seedScan(db, tenant.id, device.id);
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });
      await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ scanId: id, quotedMessageId: '00000000-0000-4000-8000-000000000000' })
        .expect(404);
      expect(await scanCount(db)).toBe(1);
      expect(existsSync(scanFilePath(id))).toBe(true);
      const media = await db.withoutTenant((tx) => tx.query('SELECT id FROM message_media'));
      expect(media.rows).toHaveLength(0);
    });

    it('vencida e 404 scan_not_found', async () => {
      const id = await seedScan(db, tenant.id, device.id, { expiresInHours: -1 });
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });
      const res = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ scanId: id })
        .expect(404);
      expect(res.body.error.details).toEqual({ reason: 'scan_not_found' });
    });

    it('corrida: duas atendentes com a mesma foto — uma 201, a outra 404 scan_not_found', async () => {
      const id = await seedScan(db, tenant.id, device.id);
      const ana = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });
      const bia = await createConversation({ tenantId: tenant.id, assignedTo: manager.id, db });
      const [a, b] = await Promise.all([
        app.agent.post(`/api/v1/conversations/${ana.id}/attachments`).set(app.auth(attendant)).send({ scanId: id }),
        app.agent.post(`/api/v1/conversations/${bia.id}/attachments`).set(app.auth(manager)).send({ scanId: id }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 404]);
      const loser = a.status === 404 ? a : b;
      expect(loser.body.error.details).toEqual({ reason: 'scan_not_found' });
      const media = await db.withoutTenant((tx) => tx.query('SELECT id FROM message_media'));
      expect(media.rows).toHaveLength(1);
    });

    it('anexo comum (sem scanId) continua igual', async () => {
      const conversation = await createConversation({ tenantId: tenant.id, assignedTo: attendant.id, db });
      const res = await app.agent
        .post(`/api/v1/conversations/${conversation.id}/attachments`)
        .set(app.auth(attendant))
        .send({ fileName: 'pedido.jpg', mimeType: 'image/jpeg', contentBase64: await jpegBase64() })
        .expect(201);
      expect(res.body.messageType).toBe('image');
    });
  });

  describe('expiracao (agendador)', () => {
    it('apaga vencidas de cada laboratorio (linha e arquivo), mantem as validas, arquivo ausente nao e erro', async () => {
      const other = await createTenant({ db });
      const otherDevice = await seedPairedDevice(db, other.id);
      const expiredA = await seedScan(db, tenant.id, device.id, { expiresInHours: -1 });
      const expiredB = await seedScan(db, other.id, otherDevice.id, { expiresInHours: -2 });
      const missingFile = await seedScan(db, other.id, otherDevice.id, { expiresInHours: -3 });
      await import('node:fs/promises').then((fs) => fs.unlink(scanFilePath(missingFile)));
      const valid = await seedScan(db, tenant.id, device.id);

      const service = new ScanService({ db, audit: createAuditService(db) });
      const result = await service.expireDue();
      expect(result.sort((x, y) => x.expired - y.expired)).toEqual(
        [
          { tenantId: tenant.id, expired: 1 },
          { tenantId: other.id, expired: 2 },
        ].sort((x, y) => x.expired - y.expired),
      );
      const left = await db.withoutTenant((tx) => tx.query<{ id: string }>('SELECT id FROM scans'));
      expect(left.rows.map((r) => r.id)).toEqual([valid]);
      expect(existsSync(scanFilePath(expiredA))).toBe(false);
      expect(existsSync(scanFilePath(expiredB))).toBe(false);
      expect(existsSync(scanFilePath(valid))).toBe(true);
      expect(await service.expireDue()).toEqual([]);
    });
  });

  it('nome do arquivo no horario de Brasilia', () => {
    expect(scanFileName(new Date('2026-11-19T12:35:12Z'), 'image/jpeg')).toBe('digitalizacao-20261119-093512.jpg');
    expect(scanFileName(new Date('2026-11-20T02:00:00Z'), 'image/png')).toBe('digitalizacao-20261119-230000.png');
  });

  it('o cookie da captura nao vale como Bearer nem abre a fila', async () => {
    await app.agent.get('/api/v1/scans').set('Cookie', device.cookie).expect(401);
    expect(device.cookie.startsWith(`${CAPTURE_COOKIE_NAME}=`)).toBe(true);
  });
});
