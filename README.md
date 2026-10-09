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

Este modo evita el costo del disco persistente. Los cierres por turno guardan las unidades vendidas y permiten compartir el resumen por WhatsApp, pero tanto las ventas pendientes como el historial de cierres se guardan en el archivo local y pueden perderse si Render duerme, reinicia o vuelve a desplegarse. Para garantizar esa persistencia haría falta una base alojada aparte; no se configura aquí para mantener el costo en cero. Para garantizar esa persistencia haría falta una base alojada aparte; no se configura aquí para mantener el costo en cero.

### Instalar y ubicar el icono

- Android: abrir la URL en Chrome y usar **Instalar aplicación** o **Agregar a pantalla de inicio**. Si el icono queda en el cajón de aplicaciones, mantenerlo presionado desde allí y arrastrarlo a la pantalla deseada. La búsqueda del teléfono normalmente no permite arrastrarlo.
- iPhone: abrir la URL en Safari, tocar **Compartir** y después **Agregar a pantalla de inicio**. Luego mantener presionado el icono para moverlo.
- Si el icono ya estaba agregado antes de una actualización, quitar ese acceso anterior y volver a agregarlo para que el teléfono use el icono actualizado.

## Privacidad y alcance

No hay usuario, clave ni permisos por persona: cualquiera que tenga la URL puede ver y modificar las mesas, los pedidos y la carta. El nombre de atención se guarda solo en el teléfono y se adjunta a los pedidos. No publiques información sensible.

La carta se carga y edita manualmente. El escaneo automático de fotos con IA no está incluido porque necesita un servicio externo.

### Combos y opciones

Al crear o editar un producto desde **Carta**, se pueden agregar grupos de opciones que aparecen únicamente al agregar ese producto al pedido. Cada grupo permite elegir una opción o indicar cantidades independientes, y puede marcarse como obligatorio. Por ejemplo, un combo puede tener un grupo obligatorio **Infusión** (una opción) y un grupo **Acompañamientos** (cantidades para tortillas, bollitos o facturas).

Los precios de las opciones se configuran como recargos por unidad: dejalos en `$0` para las alternativas incluidas en el combo y asigná un importe solo a los agregados, como manteca o mermelada. Las cantidades de opciones corresponden a cada combo; si se agregan varios combos iguales, los acompañamientos y sus recargos se multiplican por esa cantidad. Las selecciones se guardan en el pedido y se muestran también en cocina.

Cada grupo puede marcarse como **condicional** con el campo *Mostrar cuando*: elegí el grupo que lo activa y, opcionalmente, solo algunas de sus opciones. El grupo condicional permanece oculto (y sin exigir sus opciones obligatorias) hasta que se marca la opción que lo activa; en ese momento se abre su lista de cantidades con los botones `−` / `+`. Por ejemplo, el combo **Clásico** muestra los **Acompañamientos** recién al elegir la infusión, y cada acompañamiento se suma con su propia cantidad (dos tortillas gruesas, una fina y una factura, etc.).

Las mesas se agrupan por sector: **Salón adentro** (Mesa 1 a 8), **Salón afuera** (Mesa 9 a 16), **Desayunador** (D1 a D5) y **Sombrillas** (S1 y S2). Al agregar una mesa nueva se elige su sector, y la comanda de cocina muestra el sector de cada mesa. Las bases existentes se actualizan solas: conservan sus mesas y reciben las que falten.

Desde el detalle de la mesa, el mozo puede editar o cancelar productos ya enviados a cocina; los cambios se reflejan también en la comanda de cocina. Los productos cancelados no suman al total ni a las ventas y se pueden reactivar desde la mesa.

Cuando cocina termina un producto, queda como **Listo para retirar** y aparece un aviso global y dentro del pedido de su mesa. Al llevarlo, el mozo marca **Retirado** en esa mesa; el aviso desaparece y queda registrado quién lo retiró y a qué hora.

Los avisos globales se separan por mesa para identificar a dónde corresponde cada pedido. En la mesa abierta, cada producto enviado muestra su estado y cuánto tiempo lleva en cocina; cuando está listo, también indica cuánto espera para ser retirado.
