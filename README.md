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

## Publicar gratis con GitHub y Render

1. Subir esta carpeta a un repositorio de GitHub.
2. En Render, crear un servicio web nuevo desde ese repositorio y conservar `render.yaml`; el manifiesto selecciona el plan `free` y no agrega discos.
3. Verificar que Render muestre el plan **Free ($0)** antes de crear el servicio. No elegir ni confirmar un plan pago.
4. Compartir la URL HTTPS pública del servicio con el equipo. Desde esa URL, en el navegador del teléfono se puede elegir **Agregar a pantalla de inicio** o **Instalar aplicación**.

Todos los teléfonos que abran la misma URL comparten el estado actual en el servidor. El plan gratuito duerme después de 15 minutos sin visitas y puede reiniciarse; al dormir, reiniciar o volver a desplegarse, Render borra los archivos locales. Por eso las mesas abiertas y los cambios manuales de la carta pueden perderse antes de limpiar la mesa. Al volver, el servidor carga la carta inicial y todas las mesas libres. La primera visita tras dormir puede tardar alrededor de un minuto.

Este modo evita el costo del disco persistente y no guarda historial, pero no garantiza conservar una comanda abierta si nadie tiene la app activa o si Render reinicia el servicio. Para garantizar esa persistencia haría falta una base alojada aparte; no se configura aquí para mantener el costo en cero.

## Privacidad y alcance

No hay usuario, clave ni permisos por persona: cualquiera que tenga la URL puede ver y modificar las mesas, los pedidos y la carta. El nombre de atención se guarda solo en el teléfono y se adjunta a los pedidos. No publiques información sensible.

La carta se carga y edita manualmente. El escaneo automático de fotos con IA no está incluido porque necesita un servicio externo.