import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
const APLICAR = process.argv.includes('--aplicar');
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: planes } = await sb.from('subscription_plans').select('*');
const vital = new Map(planes.filter(p=>String(p.billing_cycle??'').toLowerCase()==='lifetime').map(p=>[p.id,p]));
const { data: subs } = await sb.from('subscriptions')
  .select('id,tenant_id,plan_id,status,ends_at').eq('status','active').not('ends_at','is',null);
const { data: tenants } = await sb.from('tenants').select('id,name,is_demo');
const T = Object.fromEntries(tenants.map(t=>[t.id,t]));
const objetivo = subs.filter(s => {
  const p = vital.get(s.plan_id);
  if (!p) return false;
  const t = T[s.tenant_id];
  if (!t || t.is_demo === true) return false;            // una demo vence a propósito
  if (p.admin_dashboard === true) return false;          // cuenta del super-admin
  if (/demo/i.test(p.name ?? '')) return false;
  return true;
});
console.log(APLICAR ? 'APLICANDO' : 'ENSAYO (sin escribir)');
for (const s of objetivo) console.log(` ${String(s.ends_at).slice(0,10)} → ∞ · ${T[s.tenant_id].name} · plan ${vital.get(s.plan_id).name}`);
console.log('total:', objetivo.length);
if (!APLICAR) process.exit(0);
fs.writeFileSync('/tmp/claude-1000/-home-jk-NovaPOS/002a8064-517a-4b95-b870-82962c4c45a6/scratchpad/ends_at_antes.json',
  JSON.stringify(objetivo.map(s=>({sub:s.id,tenant:s.tenant_id,nombre:T[s.tenant_id].name,ends_at:s.ends_at})),null,2));
let n=0;
for (const s of objetivo) {
  const { error } = await sb.from('subscriptions').update({ ends_at: null }).eq('id', s.id);
  if (error) console.log('  ERROR', T[s.tenant_id].name, error.message); else n++;
}
console.log('actualizadas:', n);
