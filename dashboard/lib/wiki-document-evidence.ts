import { createHash } from 'node:crypto';

export type WikiDocumentEvidenceEvent = {
  id: string;
  entity_type: string;
  entity_id: string;
  event_type: string;
  before_json: string | null;
  after_json: string | null;
  actor: string;
  source_type: string;
  correlation_id: string | null;
  created_at: string;
};

export class WikiDocumentEvidenceMissingError extends Error {
  constructor(public readonly eventId: string) {
    super(`Wiki evidence event missing: ${eventId}`);
    this.name = 'WikiDocumentEvidenceMissingError';
  }
}

export function canonicalWikiDocumentEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWikiDocumentEvidence).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalWikiDocumentEvidence(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function citedWikiDocumentEventIds(markdown: string): string[] {
  return [...markdown.matchAll(/^\[\^[^\]]+\]:\s*event:([0-9a-f-]{36})\s*$/gim)]
    .map((match) => match[1])
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
}

export function wikiDocumentEventSnapshot(event: WikiDocumentEvidenceEvent) {
  return {
    id: event.id,
    entityType: event.entity_type,
    entityId: event.entity_id,
    eventType: event.event_type,
    beforeJson: event.before_json,
    afterJson: event.after_json,
    actor: event.actor,
    sourceType: event.source_type,
    correlationId: event.correlation_id,
    createdAt: event.created_at,
  };
}

export function wikiDocumentEvidenceSnapshot(
  markdown: string,
  resolveEvent: (eventId: string) => WikiDocumentEvidenceEvent | undefined,
) {
  const eventIds = citedWikiDocumentEventIds(markdown);
  const evidence = eventIds.map((eventId) => {
    const event = resolveEvent(eventId);
    if (!event) throw new WikiDocumentEvidenceMissingError(eventId);
    return {
      eventId,
      eventHash: createHash('sha256').update(canonicalWikiDocumentEvidence(wikiDocumentEventSnapshot(event))).digest('hex'),
    };
  });
  return {
    eventIds,
    evidenceSnapshotHash: createHash('sha256').update(canonicalWikiDocumentEvidence(evidence)).digest('hex'),
  };
}
