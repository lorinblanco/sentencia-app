# ⚖️ SentencIA — Guía de instalación

Sistema de generación de proyectos de sentencia para el Tribunal del Trabajo N°5 de Quilmes.
**Tiempo estimado de instalación: 20-30 minutos. Solo requiere un navegador web.**

---

## Paso 1 — Crear cuenta en Supabase (base de datos, gratis)

1. Ir a **https://supabase.com** → clic en "Start your project"
2. Registrarse con Google o email
3. Clic en "New project"
4. Elegir nombre: `sentencia-app`, contraseña fuerte, región: `South America (São Paulo)`
5. Esperar que se cree el proyecto (~2 minutos)
6. En el menú izquierdo → **SQL Editor** → **New query**
7. Pegar el contenido completo de `supabase/schema.sql` y ejecutar (**Run**)
8. En **Settings → API** copiar:
   - `Project URL` (ej: https://abcxyz.supabase.co)
   - `anon public` key (la clave larga que empieza con eyJ...)

---

## Paso 2 — Subir el código a GitHub (gratis)

1. Ir a **https://github.com** → iniciar sesión (o crear cuenta)
2. Clic en "+" → "New repository"
3. Nombre: `sentencia-app`, privado (Private), clic "Create repository"
4. En la página del repositorio vacío, clic en **"uploading an existing file"**
5. Arrastrar TODOS los archivos de esta carpeta (incluyendo subcarpetas)
6. Clic "Commit changes"

---

## Paso 3 — Desplegar en Vercel (hosting gratis)

1. Ir a **https://vercel.com** → iniciar sesión con GitHub
2. Clic "Add New Project" → importar el repositorio `sentencia-app`
3. En "Environment Variables" agregar:
   - `VITE_SUPABASE_URL` = URL copiada en Paso 1
   - `VITE_SUPABASE_ANON_KEY` = Clave anon copiada en Paso 1
4. Clic "Deploy"
5. En ~2 minutos tendrá la URL de su app (ej: `sentencia-app.vercel.app`)

---

## Paso 4 — Configurar su cuenta de administrador

1. Abrir la URL de su app
2. Clic en "Solicitar registro" → ingresar su email y contraseña
3. Volver a **Supabase** → **SQL Editor** → ejecutar:
   ```sql
   UPDATE public.profiles SET role = 'admin' WHERE email = 'SU_EMAIL@AQUI.COM';
   ```
4. Volver a la app y refrescar → ya tiene acceso de admin
5. En **Administración → Ajustes**: cargar el valor actual del RIPTE como respaldo

---

## Paso 5 — Configurar su API key de Claude

1. Ir a **https://console.anthropic.com** → crear cuenta o iniciar sesión
2. En "API Keys" → clic "Create Key" → copiar la clave (sk-ant-api03-...)
3. En SentencIA → **Configuración** → pegar su API key → Guardar
4. ¡Listo! Puede generar sentencias.

---

## Agregar nuevos usuarios

1. El usuario ingresa a la URL de la app y se registra
2. Usted (admin) va a **Administración → Usuarios** → clic "Aprobar acceso"
3. El usuario ya puede ingresar y configurar su propia API key

---

## Costos

| Servicio | Costo |
|----------|-------|
| Vercel (hosting) | **GRATIS** |
| Supabase (base de datos) | **GRATIS** (hasta 500MB) |
| Anthropic (IA) | Cada usuario paga sus propios tokens (~$0.01-0.05 por sentencia) |
| Dominio personalizado | Opcional (~$12/año) |

---

## Soporte y actualizaciones

Para agregar nuevas materias (despidos, etc.) o plantillas adicionales: 
contactar al administrador del sistema para actualizar la base de conocimiento.

