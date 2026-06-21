import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const authConfigError = "Supabase Auth is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in Vercel.";

function authNotConfigured() {
  return { data: null, error: new Error(authConfigError) };
}

const disabledAuthClient = {
  auth: {
    async getSession() {
      return { data: { session: null }, error: null };
    },
    onAuthStateChange() {
      return { data: { subscription: { unsubscribe() {} } } };
    },
    async signInWithOAuth() {
      return authNotConfigured();
    },
    async signInWithOtp() {
      return authNotConfigured();
    },
    async signOut() {
      return { error: null };
    },
  },
};

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
  : disabledAuthClient;
