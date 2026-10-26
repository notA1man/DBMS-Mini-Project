// Creates/updates the operations collections (validators + indexes) and seeds maintenance
// history for the fleet if none exists yet.  npm run db:mongo:ops
import { clients } from './clients';
import { initOpsMongo } from '../db/mongo/ops';
import { initCommercialMongo } from '../db/mongo/commercial';
import type { MaintenanceLog } from '../src/lib/outbox/ops';

const FINDINGS = [
  ['21-51', 'Air-conditioning pack outlet temperature sensor erratic'], ['24-31', 'Battery charger fault message on ground'],
  ['27-81', 'Slat track lubrication below limits'], ['29-11', 'Green hydraulic system minor seepage at pump'],
  ['32-41', 'Main wheel tyre worn to limit'], ['32-42', 'Brake wear pin at minimum'], ['33-42', 'Navigation light inoperative'],
  ['36-11', 'Bleed valve slow to close'], ['49-11', 'APU start delayed'], ['52-11', 'Passenger door seal damaged'],
  ['72-00', 'Engine borescope: minor blade tip erosion within limits'], ['25-21', 'Seat recline actuator inoperative'],
] as const;
const PARTS = ['TYR-H44.5', 'BRK-2-1577', 'SNS-21-301', 'SEAL-52-11A', 'LGT-33-42', 'VLV-36-11', 'ACT-25-RCL', 'FLT-HYD-29'];

async function main() {
  const c = clients({ owner: true });
  try {
    if (!c.mongo) throw new Error('Set MONGODB_URI in .env');
    const db = await c.mongo();
    await initCommercialMongo(db);   // notifications must exist for ops notifications
    await initOpsMongo(db);
    const logs = db.collection<MaintenanceLog>('maintenance_logs');
    if (await logs.estimatedDocumentCount() === 0) {
      const fleet = (await c.pg.query('SELECT aircraft_id::text AS id, registration FROM aircraft ORDER BY aircraft_id')).rows;
      let seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const docs: MaintenanceLog[] = [];
      for (const a of fleet) {
        for (let k = 0; k < 6; k++) {
          const checkType = (['A', 'A', 'B', 'DEFECT', 'DEFECT', 'C'] as const)[k];
          const opened = new Date(Date.now() - (5 + rnd() * 350) * 86400000);
          const hours = checkType === 'C' ? 96 + rnd() * 120 : checkType === 'DEFECT' ? 1 + rnd() * 20 : 6 + rnd() * 18;
          const findings = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
            const [ata, description] = FINDINGS[Math.floor(rnd() * FINDINGS.length)];
            return { ata, description, severity: (rnd() < 0.08 ? 'critical' : rnd() < 0.35 ? 'major' : 'minor') as 'minor' };
          });
          docs.push({ aircraftId: a.id, registration: a.registration, checkType, openedAt: opened,
            closedAt: new Date(opened.getTime() + hours * 3600000), technician: `Engineer ${1 + Math.floor(rnd() * 24)}`,
            aogHours: Math.round(hours * 10) / 10, createdBy: null, findings,
            components: findings.map(() => ({ partNo: PARTS[Math.floor(rnd() * PARTS.length)],
              action: (rnd() < 0.5 ? 'replaced' : rnd() < 0.7 ? 'repaired' : 'inspected') as 'replaced', serial: `SN${Math.floor(rnd() * 1e6)}` })) });
        }
      }
      await logs.insertMany(docs);
      console.log(`Seeded ${docs.length} maintenance work orders.`);
    }
    console.log('MongoDB operations collections ready: flight_events (time series), flight_status, maintenance_logs, audit_log.');
  } finally { await c.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Mongo setup failed'); process.exitCode = 1; });
