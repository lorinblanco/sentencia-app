import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(url, key, {
  auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
})

// ── Auth helpers ──────────────────────────────────────────────────────────────
export async function signUp(email, password, fullName) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw error
  // Create profile (pending approval)
  await supabase.from('profiles').insert({
    id: data.user.id, email, full_name: fullName, role: 'pending'
  })
  return data
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}

export async function signOut() {
  await supabase.auth.signOut()
}

export async function getProfile(userId) {
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
  return data
}

export async function updateApiKey(userId, apiKey) {
  const { error } = await supabase
    .from('profiles')
    .update({ anthropic_api_key: apiKey })
    .eq('id', userId)
  if (error) throw new Error(error.message)
}
// ── Settings helpers ──────────────────────────────────────────────────────────
export async function getSetting(key) {
  const { data } = await supabase.from('settings').select('value').eq('key', key).single()
  return data?.value
}

export async function setSetting(key, value) {
  await supabase.from('settings').upsert({ key, value, updated_at: new Date().toISOString() })
}

// ── Sentences helpers ─────────────────────────────────────────────────────────
export async function saveSentence(userId, meta, content) {
  const { data, error } = await supabase.from('sentences').insert({
    user_id: userId, ...meta, content, created_at: new Date().toISOString()
  }).select().single()
  if (error) throw error
  return data
}

export async function getUserSentences(userId) {
  const { data } = await supabase
    .from('sentences').select('id,causa_numero,caratula,tipo_accion,created_at')
    .eq('user_id', userId).order('created_at', { ascending: false }).limit(30)
  return data || []
}

export async function getSentence(id) {
  const { data } = await supabase.from('sentences').select('*').eq('id', id).single()
  return data
}

// ── Admin helpers ─────────────────────────────────────────────────────────────
export async function getAllProfiles() {
  const { data } = await supabase.from('profiles').select('*').order('created_at')
  return data || []
}

export async function approveUser(userId) {
  await supabase.from('profiles').update({ role: 'user' }).eq('id', userId)
}

export async function revokeUser(userId) {
  await supabase.from('profiles').update({ role: 'pending' }).eq('id', userId)
}

export async function getTemplates() {
  const { data } = await supabase.from('templates').select('*').order('created_at', { ascending: false })
  return data || []
}

export async function upsertTemplate(template) {
  const { data, error } = await supabase.from('templates').upsert(template).select().single()
  if (error) throw error
  return data
}

export async function deleteTemplate(id) {
  await supabase.from('templates').delete().eq('id', id)
}
