export interface RequestDiagnostic {
  endpoint: string;
  method: string;
  headers: Headers;
  durationMs: number;
  status?: number;
  requestId?: string;
  error?: string;
}

export interface ZcodeDiagnosticSnapshot {
  endpoint?: string;
  method?: string;
  headerNames: string[];
  durationMs?: number;
  status?: number;
  requestId?: string;
  error?: string;
  requestedAt?: string;
  usageFetchedAt?: string;
}

export class ZcodeDiagnostics {
  #snapshot: ZcodeDiagnosticSnapshot = { headerNames: [] };

  recordRequest(request: RequestDiagnostic): void {
    this.#snapshot = {
      endpoint: request.endpoint,
      method: request.method,
      headerNames: [...request.headers.keys()].sort(),
      durationMs: Math.round(request.durationMs),
      ...(request.status === undefined ? {} : { status: request.status }),
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      ...(request.error === undefined ? {} : { error: request.error }),
      requestedAt: new Date().toISOString(),
      ...(this.#snapshot.usageFetchedAt === undefined ? {} : { usageFetchedAt: this.#snapshot.usageFetchedAt }),
    };
  }

  recordUsage(fetchedAt = Date.now()): void {
    this.#snapshot = {
      ...this.#snapshot,
      usageFetchedAt: new Date(fetchedAt).toISOString(),
    };
  }

  snapshot(): ZcodeDiagnosticSnapshot {
    return {
      ...this.#snapshot,
      headerNames: [...this.#snapshot.headerNames],
    };
  }
}

export const diagnostics = new ZcodeDiagnostics();
