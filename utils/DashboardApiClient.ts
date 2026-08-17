import * as https from 'https';
import * as dotenv from 'dotenv';
dotenv.config();

const BASE_URL    = (process.env.SQRX_BASE_URL ?? '').replace(/\/$/, '');
const API_KEY     = process.env.DASHBOARD_ACCESS_API ?? '';
// Auth: Basic base64(API_KEY) + x-squarex-platform header (confirmed via API probing)
const AUTH_HEADER = `Basic ${Buffer.from(API_KEY).toString('base64')}`;

export interface Policy {
  id: string;
  name: string;
  action: string;
  deleted_at: string | null;
  group_count?: number;
  group_exclusion_count?: number;
  member_count?: number;
  member_exclusion_count?: number;
  created_on?: string;
  last_updated?: string;
}

export interface Member {
  email: string;
  auto_sync: boolean;
  created_on: string;
  custom_role: string | null;
  device_domain: string | null;
  device_user_name: string | null;
  auth_config: unknown;
}

export interface Detection {
  action: string;
  agent: string;
  browser: string;
  browser_version: string;
  policy_id: string;
  [key: string]: unknown;
}

function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const url     = new URL(BASE_URL + path);
    const headers: Record<string, string | number> = {
      'Authorization':      AUTH_HEADER,
      'x-squarex-platform': 'enterprise-dashboard',
      'Accept':             'application/json',
    };
    if (payload) {
      headers['Content-Type']   = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: url.hostname, path: url.pathname, method, headers, rejectUnauthorized: false }, res => {
      let data = '';
      res.on('data', (c: string) => data += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class DashboardApiClient {
  private async post<T>(path: string, body: unknown): Promise<T> {
    const { status, json } = await request('POST', path, body);
    if (status < 200 || status >= 300) {
      throw new Error(`POST ${path}: HTTP ${status} — ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json as T;
  }

  async listPolicies(): Promise<Policy[]> {
    const body = await this.post<{ policies: Policy[] }>('/api/teams/policy/list', { page_size: 3000 });
    return body.policies ?? [];
  }

  async getPolicy(id: string): Promise<Policy> {
    const body = await this.post<{ policy: Policy; status: string }>('/api/teams/policy/get-basic', { id });
    return body.policy;
  }

  async listMembers(page = 1, size = 10, emailFilter = ''): Promise<{ members: Member[]; total: number }> {
    const body = await this.post<{ data: { members: Member[]; total: number } }>(
      '/api/teams/members/list',
      { page, size, filters: { email: emailFilter } }
    );
    return { members: body.data?.members ?? [], total: body.data?.total ?? 0 };
  }

  async listDetections(opts: {
    size?: number;
    actions?: string[];
    effects?: string[];
    severities?: string[];
    userIds?: string[];
    policyId?: string;
    start?: string;
    end?: string;
  } = {}): Promise<Detection[]> {
    const body = await this.post<{ data: { detections: Detection[] } }>(
      '/api/teams/detections',
      {
        size:       opts.size ?? 50,
        actions:    opts.actions   ?? [],
        effects:    opts.effects   ?? [],
        severities: opts.severities ?? [],
        user_ids:   opts.userIds   ?? [],
        policy_id:  opts.policyId  ?? '',
        ...(opts.start ? { start: opts.start } : {}),
        ...(opts.end   ? { end:   opts.end   } : {}),
      }
    );
    return body.data?.detections ?? [];
  }
}
