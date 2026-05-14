/**
 * Vercel REST API driver. Uses the inline-files form of /v13/deployments —
 * suitable for our single-HTML static deploys produced by the Preview engine.
 *
 * Docs: https://vercel.com/docs/rest-api/endpoints/deployments
 */

export interface VercelDeployInput {
  /** A name like 'agenthub-xxx'. Must be lowercase + dashes only. */
  name: string;
  /** Self-contained HTML body. Will be served at /. */
  html: string;
}

export interface VercelDeploymentSnapshot {
  id: string;
  /** Hostname like 'agenthub-xxx.vercel.app' (no protocol). */
  url: string;
  readyState: VercelReadyState;
  errorMessage?: string;
}

export type VercelReadyState =
  | 'INITIALIZING'
  | 'QUEUED'
  | 'BUILDING'
  | 'READY'
  | 'ERROR'
  | 'CANCELED';

const API = 'https://api.vercel.com';

export class VercelDriver {
  constructor(
    private readonly token: string,
    private readonly teamId?: string,
  ) {}

  async create(input: VercelDeployInput): Promise<VercelDeploymentSnapshot> {
    const body = {
      name: input.name,
      files: [
        {
          file: 'index.html',
          data: Buffer.from(input.html, 'utf8').toString('base64'),
          encoding: 'base64',
        },
      ],
      target: 'production',
      // `public: true` lets us request unauthenticated access. Team accounts
      // with default Deployment Protection still override this — see the
      // post-create disable step below.
      public: true,
      projectSettings: {
        framework: null,
        buildCommand: null,
        outputDirectory: null,
        installCommand: null,
        devCommand: null,
      },
    };

    const res = await fetch(this.url('/v13/deployments'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Vercel create ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as {
      id: string;
      url: string;
      readyState: VercelReadyState;
      projectId?: string;
    };

    // Best-effort: disable any Deployment Protection on the freshly created
    // project so the URL is publicly viewable. This call may 404 / 403 on
    // Hobby accounts without team scope — that's fine, we just log + skip.
    if (data.projectId) {
      void this.disableProtection(data.projectId).catch(() => undefined);
    }

    return { id: data.id, url: data.url, readyState: data.readyState };
  }

  /**
   * Turn off SSO / password protection on a project so its production URL
   * works for anonymous visitors. Idempotent and safe to call repeatedly.
   */
  async disableProtection(projectIdOrName: string): Promise<void> {
    const res = await fetch(this.url(`/v9/projects/${encodeURIComponent(projectIdOrName)}`), {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({
        ssoProtection: null,
        passwordProtection: null,
      }),
    });
    if (!res.ok) {
      // Don't throw — protection toggling permissions vary; deployment is still
      // live, the user can disable manually if needed.
      // eslint-disable-next-line no-console
      console.warn(
        `[vercel] disableProtection failed for ${projectIdOrName}: ${res.status} ${await safeText(res)}`,
      );
    }
  }

  async get(deploymentId: string): Promise<VercelDeploymentSnapshot> {
    const res = await fetch(this.url(`/v13/deployments/${deploymentId}`), {
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new Error(`Vercel get ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as {
      id: string;
      url: string;
      readyState: VercelReadyState;
      errorMessage?: string;
    };
    return {
      id: data.id,
      url: data.url,
      readyState: data.readyState,
      errorMessage: data.errorMessage,
    };
  }

  private url(path: string): string {
    if (!this.teamId) return `${API}${path}`;
    const sep = path.includes('?') ? '&' : '?';
    return `${API}${path}${sep}teamId=${encodeURIComponent(this.teamId)}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text();
  } catch {
    return '';
  }
}

/** Map Vercel's readyState to our app's deploy_status states. */
export function mapVercelState(s: VercelReadyState):
  | 'queued'
  | 'building'
  | 'ready'
  | 'failed'
  | 'rolled-back' {
  switch (s) {
    case 'READY':
      return 'ready';
    case 'BUILDING':
      return 'building';
    case 'INITIALIZING':
    case 'QUEUED':
      return 'queued';
    case 'ERROR':
    case 'CANCELED':
      return 'failed';
  }
}
