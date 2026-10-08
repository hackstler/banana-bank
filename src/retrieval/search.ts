import { appDb } from '../db';
import { config } from '../config';
import { embedTexts } from './embeddings';
import { allChunks } from './store';
import type { SearchResult } from '../types';
import { errorDetails, traceLog } from '../trace';
type SearchTraceContext = {
  runId?: string;
  userId?: string;
  conversationId?: string;
  origin?: string;
};
export async function searchDocuments(
  query: string,
  role = 'customer',
  limit = 5,
  trace: SearchTraceContext = {},
): Promise<SearchResult[]> {
  const started = Date.now();
  traceLog('rag', 'search.started', { ...trace, query, role, limit });
  try {
    const meta = appDb().prepare('SELECT value FROM meta WHERE key=?').get('index-model') as
      { value: string } | undefined;
    if (!meta) throw new Error('No document index. Run npm run setup or npm run ingest.');
    if (meta.value !== config.embeddingModel)
      throw new Error('The model does not match the index. Re-ingest the documents.');
    const [queryVector] = await embedTexts([query], trace);
    const candidates = allChunks().filter((c) => role === 'operator' || c.audience === 'public');
    const results = candidates
      .map(({ vector, ...c }) => {
        if (vector!.length !== queryVector.length)
          throw new Error('Incompatible embedding dimensions.');
        const score = vector!.reduce((sum, v, i) => sum + v * queryVector[i], 0);
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    traceLog('rag', 'search.completed', {
      ...trace,
      query,
      role,
      candidates: candidates.length,
      durationMs: Date.now() - started,
      results: results.map((result) => ({
        chunkId: result.id,
        documentId: result.documentId,
        title: result.title,
        version: result.version,
        score: result.score,
      })),
    });
    return results;
  } catch (error) {
    traceLog('rag', 'search.failed', {
      ...trace,
      query,
      role,
      durationMs: Date.now() - started,
      error: errorDetails(error),
    });
    throw error;
  }
}
