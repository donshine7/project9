import { readFileSync } from 'node:fs';
import path from 'node:path';
import { recordGroupReviewFeedback } from '../lib/group-review';
import { createBackup } from '../lib/work-db';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('Usage: Apply-GroupReviewFeedback <feedback.json>');
const input = JSON.parse(readFileSync(path.resolve(inputPath), 'utf8'));
const backup = createBackup();
const result = recordGroupReviewFeedback(input.runId, input.answers);
process.stdout.write(JSON.stringify({ backup: backup.file, ...result }, null, 2));
