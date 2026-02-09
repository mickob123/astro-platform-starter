import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://tcgptxbqqyxmvsaqiblc.supabase.co';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRjZ3B0eGJxcXl4bXZzYXFpYmxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTQwODksImV4cCI6MjA4NTk3MDA4OX0.nyTEkolz8sft-qFoHpwsLl4F4JkIEW7A3c8aPGftprc';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
