import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_PRIORITY_VERSION = 'source-priority-v2';
export const EXTERNAL_SOURCE_PRIORITY = ['easy_pat', 'registration_mail', 'excel', 'mail_inference'] as const;
export const EASY_PAT_TOOLS = [
  'easypat_status',
  'easypat_get_matter_summary',
  'easypat_list_progress',
  'easypat_list_documents',
  'easypat_list_progress_documents',
  'easypat_download_progress_document',
  'easypat_extract_progress_document_pdf',
] as const;

export type EasyPatTool = (typeof EASY_PAT_TOOLS)[number];

export function projectRoot() {
  return process.env.SSPAT_PROJECT_ROOT || path.resolve(process.cwd(), '..');
}

export function loadSourcePriorityPolicy() {
  const artifactPath = 'config/source-priority.toml';
  const content = readFileSync(path.join(projectRoot(), artifactPath), 'utf8');
  if (!content.includes(`version = "${SOURCE_PRIORITY_VERSION}"`)) throw new Error('출처 우선순위 버전이 올바르지 않습니다.');
  const order = `external_priority = [${EXTERNAL_SOURCE_PRIORITY.map((value) => `"${value}"`).join(', ')}]`;
  if (!content.includes(order)) throw new Error('출처 우선순위가 코드와 다릅니다.');
  if (!content.includes('user_confirmation_mode = "protected_override"')) throw new Error('사용자 확정값 보호 정책이 없습니다.');
  for (const tool of EASY_PAT_TOOLS) if (!content.includes(`"${tool}"`)) throw new Error(`EasyPAT 도구 설정이 없습니다: ${tool}`);
  return {
    version: SOURCE_PRIORITY_VERSION,
    externalPriority: [...EXTERNAL_SOURCE_PRIORITY],
    userConfirmedProtected: true,
    artifactPath,
    content,
    contentHash: createHash('sha256').update(content).digest('hex'),
  };
}
