// Folio · files Edge Function
// Hands out short-lived Backblaze B2 links after checking permissions in the
// database AS THE CALLER (their JWT, so RLS applies). B2 keys never leave here.
//
// Actions (POST JSON):
//   { action: 'sign-upload', purpose: 'submission', assignmentId, fileName, contentType, size }
//   { action: 'sign-upload', purpose: 'material' | 'cover', classId, fileName, contentType, size }
//       → { key, url }   (PUT the file to url within 5 minutes)
//   { action: 'sign-download', key }  → { url }  (valid 10 minutes)
//   { action: 'delete', key }         → { ok: true }
//
// Secrets (Supabase → Edge Functions → Secrets): B2_KEY_ID, B2_APPLICATION_KEY.
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { AwsClient } from 'npm:aws4fetch@1.0.20';

const B2_BUCKET = 'folio-files-approach';
const B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';
const B2_REGION = 'us-east-005';

const ALLOWED_ORIGINS = [
  'https://masolucas.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const UPLOAD_SECONDS = 300;
const DOWNLOAD_SECONDS = 600;
const MB = 1024 * 1024;

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

// Must match the database checks (submission_files.mime_type and size_bytes).
const RULES: Record<string, { maxBytes: number; types: string[] }> = {
  submission: { maxBytes: 10 * MB, types: ['image/jpeg', 'image/png', 'application/pdf', DOCX] },
  material: { maxBytes: 25 * MB, types: ['application/pdf', DOCX, PPTX, 'image/jpeg', 'image/png'] },
  cover: { maxBytes: 5 * MB, types: ['image/jpeg', 'image/png', 'image/webp'] },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const aws = new AwsClient({
  accessKeyId: Deno.env.get('B2_KEY_ID') ?? '',
  secretAccessKey: Deno.env.get('B2_APPLICATION_KEY') ?? '',
  service: 's3',
  region: B2_REGION,
});

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

function objectUrl(key: string) {
  return `${B2_ENDPOINT}/${B2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

async function presign(method: 'GET' | 'PUT', key: string, seconds: number) {
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', String(seconds));
  const signed = await aws.sign(url.toString(), { method, aws: { signQuery: true } });
  return signed.url;
}

// "Mi foto (1).HEIC" → "mi-foto-1.heic"
function safeName(name: unknown) {
  const cleaned = String(name ?? '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase()
    .slice(-80);
  return cleaned || 'file';
}

function requireUuid(value: unknown, what: string) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `Missing or invalid ${what}.`);
  return value;
}

async function rpcTrue(db: SupabaseClient, fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new HttpError(500, error.message);
  return data === true;
}

// ------------------------------------------------------------
// Actions
// ------------------------------------------------------------
async function signUpload(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const purpose = String(body.purpose);
  const rules = RULES[purpose];
  if (!rules) throw new HttpError(400, 'Unknown upload type.');

  const contentType = String(body.contentType ?? '');
  const size = Number(body.size);
  if (!rules.types.includes(contentType)) throw new HttpError(400, 'This kind of file is not allowed here.');
  if (!(size > 0 && size <= rules.maxBytes)) throw new HttpError(400, `Files must be smaller than ${rules.maxBytes / MB} MB.`);
  const name = safeName(body.fileName);

  let key: string;
  if (purpose === 'submission') {
    const assignmentId = requireUuid(body.assignmentId, 'assignment');
    const { data: assignment } = await db.from('assignments').select('id, class_id').eq('id', assignmentId).maybeSingle();
    if (!assignment) throw new HttpError(404, 'Assignment not found.');
    if (!(await rpcTrue(db, 'student_can_edit', { p_assignment: assignmentId }))) {
      throw new HttpError(403, 'This assignment is closed.');
    }
    key = `submissions/${assignment.class_id}/${assignment.id}/${userId}/${crypto.randomUUID()}-${name}`;
  } else {
    const classId = requireUuid(body.classId, 'class');
    if (!(await rpcTrue(db, 'teaches_class', { p_class: classId }))) throw new HttpError(403, 'Not allowed.');
    key = `${purpose === 'material' ? 'materials' : 'covers'}/${classId}/${crypto.randomUUID()}-${name}`;
  }

  return { key, url: await presign('PUT', key, UPLOAD_SECONDS) };
}

// Readable if the caller can see the database row that points at the file.
async function signDownload(db: SupabaseClient, body: Record<string, unknown>) {
  const key = String(body.key ?? '');
  const prefix = key.split('/')[0];
  const lookups: Record<string, [string, string]> = {
    submissions: ['submission_files', 'file_key'],
    materials: ['materials', 'file_key'],
    covers: ['books', 'cover_key'],
  };
  const lookup = lookups[prefix];
  if (!lookup) throw new HttpError(400, 'Invalid file.');

  const { data } = await db.from(lookup[0]).select('id').eq(lookup[1], key).limit(1).maybeSingle();
  if (!data) throw new HttpError(404, 'File not found.');
  return { url: await presign('GET', key, DOWNLOAD_SECONDS) };
}

// The key's path says who owns it: a student's own submission folder
// (while they can still edit), or a class the caller teaches.
async function deleteObject(db: SupabaseClient, userId: string, body: Record<string, unknown>) {
  const key = String(body.key ?? '');
  const parts = key.split('/');

  if (parts[0] === 'submissions' && parts.length === 5) {
    const [, , assignmentId, studentId] = parts;
    if (studentId !== userId) throw new HttpError(403, 'Not allowed.');
    if (!(await rpcTrue(db, 'student_can_edit', { p_assignment: requireUuid(assignmentId, 'assignment') }))) {
      throw new HttpError(403, 'This assignment is closed.');
    }
  } else if ((parts[0] === 'materials' || parts[0] === 'covers') && parts.length === 3) {
    if (!(await rpcTrue(db, 'teaches_class', { p_class: requireUuid(parts[1], 'class') }))) {
      throw new HttpError(403, 'Not allowed.');
    }
  } else {
    throw new HttpError(400, 'Invalid file.');
  }

  const response = await aws.fetch(objectUrl(key), { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new HttpError(502, 'The file could not be deleted.');
  return { ok: true };
}

// ------------------------------------------------------------
// Entry point
// ------------------------------------------------------------
Deno.serve(async (req) => {
  const cors = corsHeaders(req.headers.get('origin') ?? '');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, cors);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await db.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
    if (!user) throw new HttpError(401, 'Please sign in again.');

    const body = await req.json();
    switch (body?.action) {
      case 'sign-upload': return json(await signUpload(db, user.id, body), 200, cors);
      case 'sign-download': return json(await signDownload(db, body), 200, cors);
      case 'delete': return json(await deleteObject(db, user.id, body), 200, cors);
      default: throw new HttpError(400, 'Unknown action.');
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof HttpError ? err.message : 'Something went wrong with the file service.';
    if (status === 500) console.error(err);
    return json({ error: message }, status, cors);
  }
});
