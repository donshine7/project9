import { auditRelationshipCoverage } from '../lib/relationship-audit';
import { createBackup } from '../lib/work-db';

const backup = createBackup();
const result = auditRelationshipCoverage();
process.stdout.write(JSON.stringify({ backup: backup.file, ...result }, null, 2));
