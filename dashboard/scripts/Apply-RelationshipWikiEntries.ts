import { captureAcceptedRelationshipEntries } from '../lib/wiki';
import { createBackup } from '../lib/work-db';

const backup = createBackup();
const result = captureAcceptedRelationshipEntries();
process.stdout.write(JSON.stringify({ backup: backup.file, ...result }, null, 2));
