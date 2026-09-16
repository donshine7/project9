import { readFileSync } from 'node:fs';
import { bindAnalysis } from '../lib/analysis';
const [agentId,...files] = process.argv.slice(2);
if (!agentId || !files.length) throw new Error('Agent and files required');
let count = 0;
for (const file of files) for (const job of JSON.parse(readFileSync(file,'utf8'))) {
  bindAnalysis(job.runId,{agentId,model:'gpt-5.6-terra',effort:'medium'}); count++;
}
console.log(JSON.stringify({agentId,count}));
