import { db } from '../db/client.js';

/**
 * LA DEMO DE RESTAURANTE: un menú de verdad, cargado de una.
 *
 * Mostrarle el módulo de restaurante a un cliente con el catálogo vacío no
 * demuestra nada: el mapa sin mesas, el menú sin platos y las comandas sin a
 * dónde ir. Armar todo a mano antes de cada demostración toma media hora y
 * siempre falta algo —la estación de un plato, el precio de una bebida—.
 *
 * Esto deja el negocio listo para enseñar: categorías, platos con su precio y
 * su estación de cocina, dos preparaciones base con sus ingredientes, y el
 * salón dibujado con ocho mesas.
 *
 * Es REPETIBLE: lo que ya existe no se duplica. Si se corre dos veces, la
 * segunda no hace nada.
 */

const CATEGORIAS = ['Entradas', 'Platos fuertes', 'Bebidas', 'Postres'] as const;
type Categoria = typeof CATEGORIAS[number];

/** Los ingredientes. Precios de costo realistas para que el margen se vea. */
const INSUMOS: Array<{ nombre: string; sku: string; costo: number; unidad: string; stock: number }> = [
  { nombre: 'Arroz',            sku: 'ING-ARROZ', costo: 1.2,  unidad: 'g',  stock: 25000 },
  { nombre: 'Frijoles negros',  sku: 'ING-FRIJ',  costo: 1.8,  unidad: 'g',  stock: 12000 },
  { nombre: 'Pechuga de pollo', sku: 'ING-POLLO', costo: 4.2,  unidad: 'g',  stock: 18000 },
  { nombre: 'Lomito de res',    sku: 'ING-LOMO',  costo: 9.5,  unidad: 'g',  stock: 9000 },
  { nombre: 'Tomate',           sku: 'ING-TOMA',  costo: 1.1,  unidad: 'g',  stock: 6000 },
  { nombre: 'Cebolla',          sku: 'ING-CEBO',  costo: 0.9,  unidad: 'g',  stock: 5000 },
  { nombre: 'Culantro',         sku: 'ING-CULA',  costo: 2.0,  unidad: 'g',  stock: 800 },
  { nombre: 'Aceite',           sku: 'ING-ACEI',  costo: 2.4,  unidad: 'ml', stock: 8000 },
  { nombre: 'Hongos',           sku: 'ING-HONG',  costo: 7.0,  unidad: 'g',  stock: 3000 },
  { nombre: 'Natilla',          sku: 'ING-NATI',  costo: 3.1,  unidad: 'ml', stock: 4000 },
];

/** Los platos del menú. `estacion` es lo que manda la comanda a su impresora. */
const PLATOS: Array<{
  nombre: string; sku: string; precio: number; categoria: Categoria;
  estacion: 'Cocina' | 'Parrilla' | 'Barra'; minutos?: number;
}> = [
  { nombre: 'Casado con pollo',          sku: 'MEN-CASPOL', precio: 4500, categoria: 'Platos fuertes', estacion: 'Cocina',   minutos: 18 },
  { nombre: 'Casado con bistec',         sku: 'MEN-CASBIS', precio: 5200, categoria: 'Platos fuertes', estacion: 'Parrilla', minutos: 20 },
  { nombre: 'Lomito en salsa de hongos', sku: 'MEN-LOMHON', precio: 7900, categoria: 'Platos fuertes', estacion: 'Parrilla', minutos: 25 },
  { nombre: 'Arroz con camarones',       sku: 'MEN-ARRCAM', precio: 6500, categoria: 'Platos fuertes', estacion: 'Cocina',   minutos: 22 },
  { nombre: 'Chifrijo',                  sku: 'MEN-CHIFRI', precio: 3800, categoria: 'Entradas',       estacion: 'Cocina',   minutos: 12 },
  { nombre: 'Patacones con frijol',      sku: 'MEN-PATACO', precio: 3200, categoria: 'Entradas',       estacion: 'Cocina',   minutos: 10 },
  { nombre: 'Ceviche de corvina',        sku: 'MEN-CEVICH', precio: 4200, categoria: 'Entradas',       estacion: 'Cocina',   minutos: 8 },
  { nombre: 'Refresco natural',          sku: 'MEN-REFNAT', precio: 1200, categoria: 'Bebidas',        estacion: 'Barra',    minutos: 3 },
  { nombre: 'Cerveza nacional',          sku: 'MEN-CERVEZ', precio: 1800, categoria: 'Bebidas',        estacion: 'Barra',    minutos: 1 },
  { nombre: 'Café chorreado',            sku: 'MEN-CAFCHO', precio: 900,  categoria: 'Bebidas',        estacion: 'Barra',    minutos: 4 },
  { nombre: 'Tres leches',               sku: 'MEN-TRELEC', precio: 2400, categoria: 'Postres',        estacion: 'Barra',    minutos: 3 },
  { nombre: 'Flan de coco',              sku: 'MEN-FLACOC', precio: 2200, categoria: 'Postres',        estacion: 'Barra',    minutos: 3 },
];

/** Las dos preparaciones base, con lo que llevan. */
const SUBRECETAS = [
  {
    nombre: 'Base de arroz y frijoles', rinde: 12, unidad: 'porción',
    ingredientes: [
      { sku: 'ING-ARROZ', cantidad: 1800, unidad: 'g',  merma: 3 },
      { sku: 'ING-FRIJ',  cantidad: 900,  unidad: 'g',  merma: 3 },
      { sku: 'ING-ACEI',  cantidad: 60,   unidad: 'ml', merma: 0 },
      { sku: 'ING-CEBO',  cantidad: 120,  unidad: 'g',  merma: 10 },
    ],
  },
  {
    nombre: 'Salsa criolla', rinde: 2, unidad: 'l',
    ingredientes: [
      { sku: 'ING-TOMA', cantidad: 900, unidad: 'g',  merma: 12 },
      { sku: 'ING-CEBO', cantidad: 400, unidad: 'g',  merma: 10 },
      { sku: 'ING-CULA', cantidad: 60,  unidad: 'g',  merma: 15 },
      { sku: 'ING-ACEI', cantidad: 150, unidad: 'ml', merma: 0 },
    ],
  },
];

/** Las recetas de los platos que llevan preparación base. */
const RECETAS_PLATO = [
  {
    sku: 'MEN-CASPOL', estacion: 'Cocina', minutos: 18,
    ingredientes: [
      { sub: 'Base de arroz y frijoles', cantidad: 1,    unidad: 'und' },
      { sub: 'Salsa criolla',            cantidad: 0.08, unidad: 'l' },
      { sku: 'ING-POLLO',                cantidad: 180,  unidad: 'g', merma: 8 },
    ],
  },
  {
    sku: 'MEN-LOMHON', estacion: 'Parrilla', minutos: 25,
    ingredientes: [
      { sku: 'ING-LOMO', cantidad: 250, unidad: 'g',  merma: 12 },
      { sku: 'ING-HONG', cantidad: 90,  unidad: 'g',  merma: 5 },
      { sku: 'ING-NATI', cantidad: 70,  unidad: 'ml', merma: 0 },
    ],
  },
  {
    sku: 'MEN-CASBIS', estacion: 'Parrilla', minutos: 20,
    ingredientes: [
      { sub: 'Base de arroz y frijoles', cantidad: 1,    unidad: 'und' },
      { sub: 'Salsa criolla',            cantidad: 0.06, unidad: 'l' },
      { sku: 'ING-LOMO',                 cantidad: 160,  unidad: 'g', merma: 10 },
    ],
  },
];

/** El salón: dos zonas y ocho mesas, numeradas para que calcen con los QR. */
function mapaDelSalon() {
  const mesa = (id: string, x: number, y: number, tipo: string, label: string) =>
    ({ id, kind: 'table', x, y, rotation: 0, type: tipo, label, status: 'free' });
  return {
    items: [
      { id: 'z-salon',   kind: 'zone', x: 40,  y: 40, rotation: 0, width: 520, height: 400, label: 'Salón principal', color: '#3b82f6' },
      { id: 'z-terraza', kind: 'zone', x: 600, y: 40, rotation: 0, width: 380, height: 400, label: 'Terraza',         color: '#10b981' },
      mesa('d-m1', 90,  110, 'medium', 'Mesa 1'),
      mesa('d-m2', 250, 110, 'small',  'Mesa 2'),
      mesa('d-m3', 390, 110, 'medium', 'Mesa 3'),
      mesa('d-m4', 90,  290, 'long',   'Mesa 4'),
      mesa('d-m5', 390, 290, 'small',  'Mesa 5'),
      mesa('d-m6', 650, 110, 'medium', 'Mesa 6'),
      mesa('d-m7', 810, 110, 'medium', 'Mesa 7'),
      mesa('d-m8', 650, 290, 'small',  'Mesa 8'),
    ],
  };
}

export interface ResultadoSiembra {
  categorias: number;
  insumos: number;
  platos: number;
  subrecetas: number;
  recetas: number;
  mesas: number;
  yaEstaba: boolean;
  avisos: string[];
}

/** Siembra el menú de demostración en un negocio. Repetible: no duplica. */
export async function sembrarRestaurante(tenantId: string): Promise<ResultadoSiembra> {
  const avisos: string[] = [];
  const r: ResultadoSiembra = {
    categorias: 0, insumos: 0, platos: 0, subrecetas: 0, recetas: 0, mesas: 0,
    yaEstaba: false, avisos,
  };

  // ── Categorías ──
  const { data: catsPrevias } = await db.from('product_categories')
    .select('id, name').eq('tenant_id', tenantId);
  const catId = new Map<string, string>(
    ((catsPrevias ?? []) as any[]).map(c => [String(c.name).trim().toLowerCase(), String(c.id)]));
  for (const nombre of CATEGORIAS) {
    if (catId.has(nombre.toLowerCase())) continue;
    const { data, error } = await db.from('product_categories')
      .insert({ tenant_id: tenantId, name: nombre }).select('id').single();
    if (error) { avisos.push(`categoría ${nombre}: ${error.message}`); continue; }
    catId.set(nombre.toLowerCase(), String((data as any).id));
    r.categorias++;
  }

  // ── Productos (insumos + platos) ──
  const { data: prodPrevios } = await db.from('products')
    .select('id, sku, name').eq('tenant_id', tenantId);
  const porSku = new Map<string, string>(
    ((prodPrevios ?? []) as any[]).filter(p => p.sku).map(p => [String(p.sku), String(p.id)]));

  const crearProducto = async (fila: Record<string, unknown>, sku: string): Promise<string | null> => {
    if (porSku.has(sku)) return porSku.get(sku)!;
    let { data, error } = await db.from('products')
      .insert({ ...fila, tenant_id: tenantId, sku }).select('id').single();
    // `recipe_unit_code` necesita la migración 84: sin ella se guarda igual,
    // solo que el costo de la receta no convierte unidades.
    if (error && /recipe_unit_code/.test(error.message)) {
      const { recipe_unit_code: _u, ...resto } = fila as any;
      ({ data, error } = await db.from('products')
        .insert({ ...resto, tenant_id: tenantId, sku }).select('id').single());
      if (!error) avisos.push('sin la migración 84: los insumos quedaron sin unidad de receta');
    }
    if (error) { avisos.push(`${sku}: ${error.message}`); return null; }
    porSku.set(sku, String((data as any).id));
    return String((data as any).id);
  };

  for (const i of INSUMOS) {
    const antes = porSku.has(i.sku);
    const id = await crearProducto({
      name: i.nombre, cost_price: i.costo, unit_price: 0,
      stock_quantity: i.stock, tracks_stock: true, iva_rate: 13,
      recipe_unit_code: i.unidad,
      // Un insumo no se vende suelto: no tiene por qué salir en el comprobante.
      exclude_from_fe: true,
    }, i.sku);
    if (id && !antes) r.insumos++;
  }

  for (const p of PLATOS) {
    const antes = porSku.has(p.sku);
    const id = await crearProducto({
      name: p.nombre, unit_price: p.precio, cost_price: 0,
      category_id: catId.get(p.categoria.toLowerCase()) ?? null,
      // El plato no lleva existencias propias: lo que baja son sus ingredientes.
      stock_quantity: 0, tracks_stock: false, iva_rate: 13,
    }, p.sku);
    if (id && !antes) r.platos++;
  }

  // ── Recetas ──
  const { data: recPrevias } = await db.from('recipes')
    .select('id, name').eq('tenant_id', tenantId);
  const recId = new Map<string, string>(
    ((recPrevias ?? []) as any[]).map(x => [String(x.name).trim().toLowerCase(), String(x.id)]));

  const ingredientesDe = (lista: any[], idx = 0) => lista.map((i, k) => ({
    tenant_id: tenantId, type: i.sub ? 'subrecipe' : 'product',
    product_id: i.sub ? null : (porSku.get(i.sku) ?? null),
    sub_recipe_id: i.sub ? (recId.get(String(i.sub).toLowerCase()) ?? null) : null,
    quantity: Number(i.cantidad) || 0, unit: i.unidad ?? null, unit_code: i.unidad ?? null,
    waste_pct: Number(i.merma) || 0, seq: idx + k,
  }));

  const guardarIngredientes = async (recipeId: string, filas: any[]) => {
    const rows = filas.map(f => ({ ...f, recipe_id: recipeId }));
    let ins = await db.from('recipe_ingredients').insert(rows);
    if (ins.error && /unit_code/.test(ins.error.message ?? '')) {
      ins = await db.from('recipe_ingredients').insert(rows.map(({ unit_code: _u, ...x }) => x));
    }
    if (ins.error) avisos.push(`ingredientes: ${ins.error.message}`);
  };

  for (const s of SUBRECETAS) {
    if (recId.has(s.nombre.toLowerCase())) continue;
    const { data, error } = await db.from('recipes').insert({
      tenant_id: tenantId, name: s.nombre, is_subrecipe: true,
      yield_qty: s.rinde, yield_unit: s.unidad, yield_unit_code: s.unidad,
      station: 'Cocina', is_active: true,
    }).select('id').single();
    if (error) { avisos.push(`subreceta ${s.nombre}: ${error.message}`); continue; }
    const id = String((data as any).id);
    recId.set(s.nombre.toLowerCase(), id);
    await guardarIngredientes(id, ingredientesDe(s.ingredientes));
    r.subrecetas++;
  }

  for (const rec of RECETAS_PLATO) {
    const plato = PLATOS.find(p => p.sku === rec.sku)!;
    if (recId.has(plato.nombre.toLowerCase())) continue;
    const productId = porSku.get(rec.sku) ?? null;
    const { data, error } = await db.from('recipes').insert({
      tenant_id: tenantId, name: plato.nombre, is_subrecipe: false,
      product_id: productId, yield_qty: 1, yield_unit: 'porción',
      station: rec.estacion, prep_minutes: rec.minutos, is_active: true,
    }).select('id').single();
    if (error) { avisos.push(`receta ${plato.nombre}: ${error.message}`); continue; }
    const id = String((data as any).id);
    recId.set(plato.nombre.toLowerCase(), id);
    await guardarIngredientes(id, ingredientesDe(rec.ingredientes));
    r.recetas++;
  }

  // ── El salón ──
  const { data: mapaPrevio } = await db.from('settings')
    .select('id, config').eq('tenant_id', tenantId).eq('type', 'tables-map').maybeSingle();
  const tieneMesas = (((mapaPrevio as any)?.config?.items ?? []) as any[]).length > 0;
  if (!tieneMesas) {
    const mapa = mapaDelSalon();
    const fila = {
      tenant_id: tenantId, type: 'tables-map', config: mapa,
      updated_at: new Date().toISOString(),
    };
    const up = mapaPrevio
      ? await db.from('settings').update(fila).eq('id', (mapaPrevio as any).id)
      : await db.from('settings').insert(fila);
    if (up.error) avisos.push(`mapa de mesas: ${up.error.message}`);
    else r.mesas = mapa.items.filter(i => i.kind === 'table').length;
  } else {
    avisos.push('el mapa de mesas ya estaba hecho: no se tocó');
  }

  r.yaEstaba = r.platos === 0 && r.recetas === 0 && r.mesas === 0;
  return r;
}
