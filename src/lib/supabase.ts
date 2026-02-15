import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://tcgptxbqqyxmvsaqiblc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjZ3B0eGJxcXl4bXZzYXFpYmxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTQwODksImV4cCI6MjA4NTk3MDA4OX0.nyTEkolz8sft-qFoHpwsLl4F4JkIEW7A3c8aPGftprc';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

/**
 * Get a valid access token. Only refreshes when the token is expired
 * or close to expiry — avoids wiping a valid session.
 * Returns null if not authenticated (caller should redirect to /login).
 */
export async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  // If token still has > 2 minutes of life, use it as-is
  const expiresAt = session.expires_at ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  if (expiresAt - nowSec > 120) {
    return session.access_token;
  }

  // Token is expired or expiring soon — try to refresh
  const { data: { session: refreshed } } = await supabase.auth.refreshSession();
  return refreshed?.access_token ?? null;
}
