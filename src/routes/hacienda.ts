import { Hono } from 'hono';

const hacienda = new Hono();

const stub = (c: any) =>
  c.json(
    {
      data: null,
      error: 'Hacienda integration not yet configured — pending certificate setup',
    },
    501
  );

hacienda.post('/emit',            stub);
hacienda.get('/status/:clave',    stub);
hacienda.post('/cancel',          stub);

export default hacienda;
