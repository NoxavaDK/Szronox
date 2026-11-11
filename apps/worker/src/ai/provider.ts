import { readFile } from 'node:fs/promises';

export interface GeminiCandidate {
  content?: { parts?: Array<{ text?: string }> };
  finishReason?: string;
  groundingMetadata?: Record<string, unknown>;
  urlContextMetadata?: Record<string, unknown>;
}
export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, unknown>;
}
export class ProviderError extends Error {
  /** `detail` is a short cause category (e.g. `http_429`, `timeout`); never content or secrets. */
  constructor(readonly code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_ACCESS_DENIED' | 'PROVIDER_RESOURCE_MISSING' | 'INVALID_AI_RESULT', readonly retryable: boolean, readonly detail?: string) {
    super(code);
    this.name = 'ProviderError';
  }
}

/** Only the worker reads the mounted key. It never appears in argv, SQL or errors. */
export async function geminiClient(keyFile: string, fetchImpl: typeof fetch = fetch, timeoutMs = 45_000) {
  let key: string;
  try { key = (await readFile(keyFile, 'utf8')).trim(); }
  catch { throw new ProviderError('PROVIDER_UNAVAILABLE', false); }
  if (!key) throw new ProviderError('PROVIDER_UNAVAILABLE', false);

  return async (model: string, request: Record<string, unknown>): Promise<GeminiResponse> => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(request), signal: abort.signal,
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new ProviderError('PROVIDER_ACCESS_DENIED', false);
        if (response.status === 404) throw new ProviderError('PROVIDER_RESOURCE_MISSING', false);
        if (response.status === 429 || response.status >= 500) throw new ProviderError('PROVIDER_UNAVAILABLE', true, `http_${response.status}`);
        throw new ProviderError('INVALID_AI_RESULT', false, `http_${response.status}`);
      }
      const answer = await response.json() as GeminiResponse;
      if (answer.promptFeedback?.blockReason) throw new ProviderError('INVALID_AI_RESULT', false);
      const candidate = answer.candidates?.[0];
      if (!candidate || candidate.finishReason !== 'STOP' || !candidate.content?.parts?.some((part) => typeof part.text === 'string')) {
        throw new ProviderError('INVALID_AI_RESULT', false, `finish_${candidate?.finishReason ?? 'none'}`);
      }
      return answer;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('PROVIDER_UNAVAILABLE', true, abort.signal.aborted ? 'timeout' : 'network');
    } finally { clearTimeout(timeout); }
  };
}

export function candidateText(response: GeminiResponse): string {
  const text = response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (text.length > 150_000) throw new ProviderError('INVALID_AI_RESULT', false);
  return text;
}
