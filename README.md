# Comanda del bar

Aplicación web instalable para compartir mesas, pedidos, carta y cocina entre varios teléfonos sin cuentas ni contraseñas.

## Ejecutar en la computadora

1. Instalar Python 3.11 o más nuevo.
2. En una terminal, dentro de esta carpeta:

   ```powershell
   py -m venv .venv
   .venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   py app.py
   ```

3. Abrir `http://localhost:8000`.

La base local se crea en `instance/comanda.sqlite3`. Para probar desde otro teléfono en la misma red, abrir la dirección IP local de la computadora en lugar de `localhost`.

## Publicar con GitHub y Render

1. Subir esta carpeta a un repositorio de GitHub.
2. En Render, crear un servicio web nuevo desde ese repositorio y conservar `render.yaml`.
3. Esperar que termine la publicación. Render instala las dependencias, inicia el servidor y guarda la base en un disco persistente; el disco puede requerir un plan pago.
4. Compartir la URL HTTPS pública del servicio con el equipo. Desde esa URL, en el navegador del teléfono se puede elegir **Agregar a pantalla de inicio** o **Instalar aplicación**.

Todos los teléfonos que abran la misma URL comparten el mismo estado. Las pantallas consultan cambios cada dos segundos y las acciones se guardan en el servidor.

## Privacidad y alcance

No hay usuario, clave ni permisos por persona: cualquiera que tenga la URL puede ver y modificar las mesas, los pedidos y la carta. El nombre de atención se guarda solo en el teléfono y se adjunta a los pedidos. No publiques información sensible.

La carta se carga y edita manualmente. El escaneo automático de fotos con IA no está incluido porque necesita un servicio externo.