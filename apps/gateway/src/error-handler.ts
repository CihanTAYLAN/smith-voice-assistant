import type { ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * `app.onError`: beklenmeyen hata JSON 500 olur ve gunluge yalniz hata ADI ile
 * yol yazilir. Hono'nun varsayilan isleyicisi `console.error(err)` ile hatanin
 * MESAJINI basar; govde parse hatalari (`Unexpected token 'h', ..."password":
 * hunter2hun"... is not valid JSON`) bu yolla parolanin ilk karakterlerini
 * gunluge yaziyordu. Mesaj ve yigin kasten loglanmaz (diger gateway gunlukleriyle
 * ayni kural).
 */
export const maskedErrorHandler: ErrorHandler = (error, c) => {
  if (error instanceof HTTPException) return error.getResponse();
  console.error(`[gateway] istek hatasi (${error.name}): ${c.req.method} ${c.req.path}`);
  return c.json({ error: 'Sunucu hatasi.' }, 500);
};
