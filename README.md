# THE FIRS SCREAM Access

PWA de control de acceso para preventas digitales. Diseñada para usarse con un solo celular y seguir funcionando sin internet después de la instalación inicial.

## Funciones
- Folios aleatorios no secuenciales.
- QR firmado con HMAC-SHA256 (firma truncada a 128 bits).
- Validación: válido / ya utilizado / cancelado / inexistente / firma inválida.
- Base de datos local IndexedDB.
- Escaneo con cámara y validación manual por folio.
- Lista de boletos, búsqueda, edición, cancelación, eliminación y deshacer entrada.
- Estadísticas e ingreso registrado.
- Generación y compartición de boleto PNG.
- Exportación/importación de respaldo, incluyendo la clave criptográfica del evento.
- Service Worker para uso offline.

## Publicar en GitHub Pages
1. Sube todos los archivos de esta carpeta a un repositorio.
2. En GitHub: Settings > Pages > Deploy from a branch.
3. Elige `main` y `/ (root)`.
4. Abre la URL HTTPS desde el celular con internet la primera vez.
5. Permite cámara, crea un boleto de prueba y recarga una vez.
6. Añade la página a la pantalla de inicio.
7. Activa modo avión y comprueba que abre, muestra la base y escanea antes del evento.

## Importante
La base vive en el navegador del dispositivo. No borres los datos del navegador ni desinstales la PWA sin haber exportado antes un respaldo JSON.

El sistema detecta reutilización después del primer ingreso. Como cualquier boleto QR estático, una captura auténtica puede ser presentada por otra persona antes que el comprador original; el primer escaneo válido gana. Para este evento, al usar un solo dispositivo, no hay conflictos de sincronización entre puertas.

## Librerías
- html5-qrcode 2.3.8 (Apache-2.0), cargada desde unpkg y almacenada por el Service Worker.
- QRCode.js 1.0.0 (MIT), cargada desde cdnjs y almacenada por el Service Worker.
