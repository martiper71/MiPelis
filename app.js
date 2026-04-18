// Registro de Service Worker para PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log("SW registration failed: ", err));
    });
}

// Usamos la API KEY del archivo config.js (que no se sube a GitHub)
const API_KEY = window.CONFIG.TMDB_API_KEY;

// Inicializar PocketBase
const pb = new PocketBase(window.CONFIG.PB_URL);
pb.autoCancellation(false); // Desactivar auto-cancelado para evitar errores de peticiones simultáneas

let peliculaActual = null; // Estado de la película abierta
let syncQueue = Promise.resolve(); // Cola de promesas secuencial
let pendingRecords = 0; // Contador de peticiones activas
let ratingSeleccionado = 0;

function initStars() {
    const stars = document.querySelectorAll('.star');
    stars.forEach(star => {
        star.addEventListener('click', () => {
            ratingSeleccionado = parseInt(star.getAttribute('data-value'));
            stars.forEach(s => {
                s.classList.toggle('active', parseInt(s.getAttribute('data-value')) <= ratingSeleccionado);
            });
        });
    });
}

function updateAuthUI() {
    const isLogged = pb.authStore.isValid && pb.authStore.model;

    // Solo controlamos la pantalla de login
    document.getElementById('loginOverlay').className = isLogged ? 'hidden' : '';

    if (isLogged) {
        cargarMisPeliculas();
    } else {
        // Ocultar todas las secciones si no hay login
        document.getElementById('sectionPendiente').classList.add('hidden');
        document.getElementById('sectionCasa').classList.add('hidden');
        document.getElementById('sectionCine').classList.add('hidden');
    }
}

async function login() {
    const email = document.getElementById('emailInput').value;
    const pass = document.getElementById('passInput').value;
    const btn = document.getElementById('btnLogin');
    const loading = document.getElementById('loginLoading');

    if (!email || !pass) return;

    // Mostrar estado de carga
    btn.disabled = true;
    btn.innerText = "Iniciando sesión...";
    loading.classList.remove('hidden');

    try {
        await pb.collection('users').authWithPassword(email, pass);
        updateAuthUI();
    } catch (e) {
        alert("Error: " + e.message);
        // Restaurar estado si falla
        btn.disabled = false;
        btn.innerText = "Entrar";
        loading.classList.add('hidden');
    }
}

async function logout() {
    pb.authStore.clear();

    // Limpiar Cachés de la PWA/Navegador para forzar actualización
    if ('caches' in window) {
        try {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map(name => caches.delete(name)));
            console.log("[PWA] Caché eliminada satisfactoriamente");
        } catch (e) {
            console.error("[PWA] Error al limpiar caché:", e);
        }
    }

    // Desvincular Service Workers (si existen) para asegurar carga fresca
    if ('serviceWorker' in navigator) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();
            for (let registration of registrations) {
                await registration.unregister();
            }
        } catch (e) {
            console.error("[PWA] Error al desincorporar Service Worker:", e);
        }
    }

    // Forzar recarga completa desde el servidor (evitando caché de disco)
    window.location.reload(true);
}

// --- GESTIÓN DE PANTALLAS DE AUTENTICACIÓN ---
function mostrarPantalla(id) {
    // Ocultar todas las tarjetas
    document.getElementById('cardLogin').classList.add('hidden');
    document.getElementById('cardRegistro').classList.add('hidden');
    document.getElementById('cardReset').classList.add('hidden');
    // Mostrar la seleccionada
    document.getElementById(id).classList.remove('hidden');
}

async function registrarUsuario() {
    const email = document.getElementById('regEmail').value;
    const pass = document.getElementById('regPass').value;
    const confirm = document.getElementById('regPassConfirm').value;
    const btn = document.getElementById('btnRegistro');
    const loading = document.getElementById('regLoading');

    if (!email || !pass || pass !== confirm) {
        alert("Por favor, rellena todos los campos correctamente.");
        return;
    }

    // Mostrar estado de carga
    btn.disabled = true;
    btn.innerText = "Procesando...";
    loading.classList.remove('hidden');

    try {
        await pb.collection('users').create({
            email,
            password: pass,
            passwordConfirm: confirm,
            emailVisibility: true
        });
        alert("¡Cuenta creada! Ya puedes iniciar sesión.");
        mostrarPantalla('cardLogin');
    } catch (e) {
        alert("Error al registrar: " + e.message);
    } finally {
        // Restaurar estado
        btn.disabled = false;
        btn.innerText = "Crear cuenta";
        loading.classList.add('hidden');
    }
}

async function solicitarReseteo() {
    const email = document.getElementById('resetEmail').value;
    if (!email) {
        alert("Por favor, introduce tu email.");
        return;
    }
    try {
        await pb.collection('users').requestPasswordReset(email);
        alert("Si el email existe en nuestra base, recibirás un mensaje de recuperación.");
        mostrarPantalla('cardLogin');
    } catch (e) {
        alert("Error: " + e.message);
    }
}

function mostrarAvisoGuardado(texto) {
    const statusBadge = document.querySelector('#detailBody .status-badge');
    if (statusBadge) {
        const originalText = statusBadge.innerText;
        const originalClass = statusBadge.className;
        statusBadge.innerText = texto || "✓ GUARDADO";
        statusBadge.style.backgroundColor = "#22c55e"; // Verde éxito
        statusBadge.style.color = "white";

        setTimeout(() => {
            if (peliculaActual) {
                statusBadge.innerText = peliculaActual.estado.toUpperCase();
                statusBadge.className = originalClass;
                statusBadge.style.backgroundColor = ""; // Volver al CSS
                statusBadge.style.color = "";
            }
        }, 1500);
    }
}

async function cargarMisPeliculas() {
    if (!pb.authStore.isValid) return;

    const gridPendiente = document.getElementById('gridPendiente');
    const gridCasa = document.getElementById('gridCasa');
    const gridCine = document.getElementById('gridCine');

    // Limpiar y ocultar secciones inicialmente
    [gridPendiente, gridCasa, gridCine].forEach(g => {
        if (g) {
            g.innerHTML = '';
            if (g.parentElement) g.parentElement.classList.add('hidden');
        }
    });

    try {
        const records = await pb.collection(window.CONFIG.COLLECTION_NAME).getFullList({
            filter: `user = "${pb.authStore.model.id}"`,
            sort: '-updated',
        });

        if (records.length === 0) {
            document.getElementById('statsContainer').classList.add('hidden');
            return;
        }

        let totalVistas = 0;
        let totalMinutos = 0;
        const mapaGeneros = {};

        records.forEach(pelicula => {
            const estado = pelicula.estado || 'Pendiente';
            // Tiempo invertido (si ya está vista)
            if (estado === 'En casa' || estado === 'En el cine') {
                totalVistas++;
                const duracion = pelicula.duracion_media || 120;
                totalMinutos += duracion;
            }

            // Contar géneros
            if (pelicula.generos) {
                pelicula.generos.split(', ').forEach(g => {
                    mapaGeneros[g] = (mapaGeneros[g] || 0) + 1;
                });
            }

            const releaseDate = pelicula.fecha_estreno || pelicula.release_date || '';
            const yearForCard = releaseDate ? releaseDate.split('-')[0] : 'Sin fecha';
            const statusClass = 'status-' + estado.toLowerCase().replace(/ /g, '').replace('í', 'i');

            const card = document.createElement('div');
            card.className = 'card';
            card.onclick = () => mostrarDetalle(pelicula, true);

            const displayEstado = estado === 'En casa' ? 'CASA' : (estado === 'En el cine' ? 'CINE' : (estado === 'Pendiente' ? 'PDTE.' : estado.toUpperCase()));

            card.innerHTML = `
                <img src="${pelicula.poster_url || 'https://via.placeholder.com/500x750?text=No+Image'}" alt="${pelicula.titulo}">
                <div class="card-info">
                    <div class="card-title">${pelicula.titulo}</div>
                    <div class="card-year">
                        <span>${yearForCard}</span>
                        <span class="status-badge ${statusClass}">${displayEstado}</span>
                    </div>
                </div>
            `;

            // Mandar a su grid correspondiente
            if (estado === 'Pendiente') {
                gridPendiente.appendChild(card);
                gridPendiente.parentElement.classList.remove('hidden');
            } else if (estado === 'En casa') {
                gridCasa.appendChild(card);
                gridCasa.parentElement.classList.remove('hidden');
            } else if (estado === 'En el cine') {
                gridCine.appendChild(card);
                gridCine.parentElement.classList.remove('hidden');
            }
        });

        // Actualizar Estadísticas
        document.getElementById('statPendientes').innerText = records.filter(r => (r.estado || 'Pendiente') === 'Pendiente').length;
        document.getElementById('statEnCasa').innerText = records.filter(r => r.estado === 'En casa').length;
        document.getElementById('statEnCine').innerText = records.filter(r => r.estado === 'En el cine').length;

        // Formatear Tiempo
        const horasTotales = Math.floor(totalMinutos / 60);
        const dias = Math.floor(horasTotales / 24);
        const horasRestantes = horasTotales % 24;

        if (dias > 0) {
            document.getElementById('statTiempo').innerText = `${dias}d ${horasRestantes}h`;
        } else {
            document.getElementById('statTiempo').innerText = `${horasTotales}h`;
        }

        // Género Top
        const generosSorted = Object.entries(mapaGeneros).sort((a, b) => b[1] - a[1]);
        const topGenero = generosSorted.length > 0 ? generosSorted[0][0] : '-';

        let mensaje = "";
        if (topGenero === '-') {
            mensaje = "🍿 ¡Empieza a añadir películas a tu colección!";
        } else {
            mensaje = `🎬 Tu género favorito es <strong>${topGenero}</strong>. ¡Has visto <strong>${horasTotales} horas</strong> de cine!`;
        }

        document.getElementById('statsMessage').innerHTML = mensaje;
        document.getElementById('statsContainer').classList.remove('hidden');

    } catch (error) {
        console.error('Error al cargar películas:', error);
    }
}

let verificandoNovedades = false;
let updateCheckDone = false;

// La verificación de novedades para películas es más sencilla, solemos buscar si ya se han estrenado o han salido en digital
// De momento lo dejamos como una función vacía o simplificada
async function verificarNovedades(peliculas) {
    // Implementar si es necesario
}

async function buscarPeliculas() {
    const query = document.getElementById('searchInput').value;
    const resultsDiv = document.getElementById('results');
    const searchResultsSection = document.getElementById('searchResultsSection');

    if (!query) return alert("Escribe el título de una película...");

    searchResultsSection.classList.remove('hidden');
    resultsDiv.innerHTML = '<p style="text-align:center; grid-column: 1/-1;">Buscando...</p>';

    try {
        const misPeliculas = await pb.collection(window.CONFIG.COLLECTION_NAME).getFullList({
            filter: `user = "${pb.authStore.model.id}"`,
            fields: 'tmdb_id'
        });
        const idsEnColeccion = new Set(misPeliculas.map(p => String(p.tmdb_id)));

        let results = [];

        if (/^\d+$/.test(query.trim())) {
            const idToSearch = query.trim();
            const urlId = `https://api.themoviedb.org/3/movie/${idToSearch}?api_key=${API_KEY}&language=es-ES`;
            const responseId = await fetch(urlId);

            if (responseId.ok) {
                const peliculaPorId = await responseId.json();
                if (peliculaPorId) results = [peliculaPorId];
            }
        }

        if (results.length === 0) {
            const urlSearch = `https://api.themoviedb.org/3/search/movie?api_key=${API_KEY}&query=${encodeURIComponent(query)}&language=es-ES`;
            const responseSearch = await fetch(urlSearch);
            const dataSearch = await responseSearch.json();
            results = dataSearch.results;
        }

        resultsDiv.innerHTML = '';

        if (!results || results.length === 0) {
            resultsDiv.innerHTML = '<p>No se encontraron películas.</p>';
            return;
        }

        results.forEach(pelicula => {
            const yaEnLista = idsEnColeccion.has(String(pelicula.id));
            const poster = pelicula.poster_path
                ? `https://image.tmdb.org/t/p/w500${pelicula.poster_path}`
                : 'https://via.placeholder.com/500x750?text=No+Image';

            const year = pelicula.release_date ? pelicula.release_date.split('-')[0] : 'Sin fecha';

            const card = document.createElement('div');
            card.className = 'card';
            card.onclick = () => mostrarDetalle(pelicula, yaEnLista);

            card.innerHTML = `
                ${yaEnLista ? '<div class="card-tmdb-status tmdb-status-returning" style="background: #6366f1; color: white;">EN TU LISTA</div>' : ''}
                <img src="${poster}" alt="${pelicula.title}">
                <div class="card-info">
                    <div class="card-title">${pelicula.title || pelicula.name}</div>
                    <div class="card-year">${year}</div>
                </div>
            `;

            resultsDiv.appendChild(card);
        });

    } catch (error) {
        console.error('Error:', error);
        resultsDiv.innerHTML = '<p>Hubo un error al buscar (mira la consola).</p>';
    }
}

async function mostrarDetalle(pelicula, esDeColeccion) {
    const detailView = document.getElementById('detailView');
    const detailBody = document.getElementById('detailBody');

    if (!pelicula.collectionId) {
        try {
            const tmdbId = pelicula.id || pelicula.tmdb_id;
            const existe = await pb.collection(window.CONFIG.COLLECTION_NAME).getList(1, 1, {
                filter: `user = "${pb.authStore.model.id}" && tmdb_id = "${tmdbId}"`
            });

            if (existe.totalItems > 0) {
                pelicula = existe.items[0];
                esDeColeccion = true;
            }
        } catch (e) {
            console.error("Error al verificar pertenencia a la colección:", e);
        }
    }

    peliculaActual = JSON.parse(JSON.stringify(pelicula));

    const titulo = peliculaActual.titulo || peliculaActual.title || peliculaActual.name;
    const poster = peliculaActual.poster_url || (peliculaActual.poster_path ? `https://image.tmdb.org/t/p/w500${peliculaActual.poster_path}` : 'https://via.placeholder.com/500x750?text=No+Image');
    const fecha = peliculaActual.fecha_estreno || peliculaActual.release_date;
    const year = fecha ? fecha.split('-')[0] : 'Sin fecha';
    const sinopsis = peliculaActual.sinopsis || peliculaActual.overview || 'Sin descripción disponible.';
    const puntuacion = peliculaActual.puntuacion_tmdb || peliculaActual.vote_average || '0.0';
    const tmdbId = peliculaActual.tmdb_id || peliculaActual.id;

    detailBody.innerHTML = `
        <img class="detail-poster" src="${poster}" alt="${titulo}">
        <div class="detail-info">
            <div class="detail-title">${titulo}</div>
            <div class="detail-meta">
                <span>🗓️ ${year}</span>
                <span>⭐ <span class="rating-badge">${puntuacion}</span></span>
            </div>
            <div class="detail-synopsis">${sinopsis}</div>
            <div id="seasonsLoading">Cargando detalles...</div>
        </div>
    `;

    detailView.style.display = 'block';
    document.body.style.overflow = 'hidden';

    try {
        const url = `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${API_KEY}&language=es-ES`;
        const response = await fetch(url);
        const fullData = await response.json();

        // Extraer duración y fecha real
        const duracion = fullData.runtime || peliculaActual.duracion_media || 0;
        const fechaReal = fullData.release_date || peliculaActual.fecha_estreno || peliculaActual.release_date;
        const yearReal = fechaReal ? fechaReal.split('-')[0] : 'Sin fecha';

        let actionButtons = '';
        if (!esDeColeccion) {
            actionButtons = `<button onclick='event.stopPropagation(); seleccionarPelicula(${JSON.stringify(peliculaActual).replace(/'/g, "&apos;")})'>＋ Añadir a mi lista</button>`;
        } else {
            const estadoActual = peliculaActual.estado || 'Pendiente';
            const statusClass = 'status-' + estadoActual.toLowerCase().replace(/ /g, '').replace('í', 'i');

            if (estadoActual === 'Pendiente') {
                actionButtons = `
                    <div class="movie-controls">
                        <span class="status-badge ${statusClass}">${estadoActual.toUpperCase()}</span>
                        <div class="btn-group" style="margin-top:20px; display:flex; gap:10px;">
                            <button class="btn-casa" style="flex:1" onclick="cambiarEstado('En casa')">🏠 Casa</button>
                            <button class="btn-cine" style="flex:1" onclick="cambiarEstado('En el cine')">📽️ Cine</button>
                        </div>
                    </div>
                `;
            } else {
                const displayEstado = estadoActual === 'En casa' ? 'CASA' : (estadoActual === 'En el cine' ? 'CINE' : (estadoActual === 'Pendiente' ? 'PDTE.' : estadoActual.toUpperCase()));
                actionButtons = `
                    <div class="movie-controls">
                        <span class="status-badge ${statusClass}">${displayEstado}</span>
                    </div>
                `;
            }
        }

        detailBody.innerHTML = `
            <img class="detail-poster" src="${poster}" alt="${titulo}">
            <div class="detail-info">
                <div style="display: flex; justify-content: space-between; align-items: start; gap: 20px; margin-bottom: 20px;">
                    <div class="detail-title" style="margin: 0;">${titulo}</div>
                    ${esDeColeccion ? `<button class="btn-delete-detail" onclick="borrarPelicula('${peliculaActual.id}', '${titulo.replace(/'/g, "\\'")}')">🗑️ Eliminar</button>` : ''}
                </div>
                <div class="detail-meta">
                    <span>🗓️ ${yearReal}</span>
                    <span>⭐ <span class="rating-badge">${puntuacion}</span></span>
                    ${duracion > 0 ? `<span>⏱️ ${duracion} min</span>` : ''}
                </div>
                <div class="detail-synopsis">${sinopsis}</div>
                ${actionButtons}
                
                ${esDeColeccion && peliculaActual.rated ? `
                    <div class="finished-info" style="margin-top:30px; background: rgba(99, 102, 241, 0.1); padding: 15px; border-radius: 12px; border: 1px solid var(--primary);">
                        <div style="font-weight: 600; margin-bottom: 10px; font-size: 0.9rem; text-transform: uppercase; color: var(--primary);">Tu valoración</div>
                        <div class="stars">${'★'.repeat(peliculaActual.rated)}${'☆'.repeat(5 - peliculaActual.rated)}</div>
                        ${peliculaActual.comentarios ? `<div class="comments" style="margin-top: 10px; color: white;">"${peliculaActual.comentarios}"</div>` : ''}
                        <button onclick="mostrarFinishModal()" style="margin-top: 15px; padding: 6px 12px; font-size: 0.8rem; background: transparent; border: 1px solid var(--primary); color: var(--primary);">Editar reseña</button>
                    </div>
                ` : ''}
            </div>
        `;

    } catch (error) {
        console.error('Error al cargar detalles:', error);
    }
}

async function cambiarEstado(nuevoEstado) {
    if (!peliculaActual || !peliculaActual.id) return;

    try {
        const data = { estado: nuevoEstado };

        // Incrementar contadores si se marca como vista
        if (nuevoEstado === 'En casa') {
            data.num_casa = (peliculaActual.num_casa || 0) + 1;
        } else if (nuevoEstado === 'En el cine') {
            data.num_cine = (peliculaActual.num_cine || 0) + 1;
        }

        await pb.collection(window.CONFIG.COLLECTION_NAME).update(peliculaActual.id, data);

        // Actualizar estado local
        peliculaActual = { ...peliculaActual, ...data };
        mostrarAvisoGuardado();

        if (nuevoEstado === 'En casa' || nuevoEstado === 'En el cine') {
            setTimeout(mostrarFinishModal, 500);
        }

        mostrarDetalle(peliculaActual, true);
    } catch (error) {
        console.error("Error al cambiar estado:", error);
    }
}

async function seleccionarPelicula(pelicula) {
    if (!pb.authStore.isValid || !pb.authStore.model) {
        alert("Debes estar logueado para añadir películas.");
        return;
    }

    const userModel = pb.authStore.model;
    const titulo = pelicula.title || pelicula.name || pelicula.titulo;

    try {
        const tmdbId = pelicula.id || pelicula.tmdb_id;
        const existe = await pb.collection(window.CONFIG.COLLECTION_NAME).getList(1, 1, {
            filter: `user = "${userModel.id}" && tmdb_id = "${tmdbId}"`
        });

        if (existe.totalItems > 0) {
            alert(`⚠️ "${titulo}" ya está en tu lista.`);
            return;
        }

        const tmdbRes = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${API_KEY}&language=es-ES`);
        const fullData = await tmdbRes.json();

        const generos = fullData.genres ? fullData.genres.map(g => g.name).join(', ') : '';
        const duracion = fullData.runtime || 120;

        const datosParaPB = {
            titulo: titulo,
            tmdb_id: tmdbId,
            sinopsis: fullData.overview || pelicula.overview || pelicula.sinopsis,
            poster_url: fullData.poster_path ? `https://image.tmdb.org/t/p/w500${fullData.poster_path}` : (pelicula.poster_url || ''),
            fecha_estreno: fullData.release_date || pelicula.release_date || pelicula.fecha_estreno || '',
            puntuacion_tmdb: fullData.vote_average || pelicula.puntuacion_tmdb,
            estado: 'Pendiente',
            generos: generos,
            duracion_media: duracion,
            num_casa: 0,
            num_cine: 0,
            user: userModel.id
        };

        await pb.collection(window.CONFIG.COLLECTION_NAME).create(datosParaPB);
        await cerrarDetalle();
    } catch (error) {
        console.error('Error al guardar:', error);
    }
}

async function cerrarDetalle() {
    document.getElementById('detailView').style.display = 'none';
    document.body.style.overflow = 'auto';
    peliculaActual = null;
    document.getElementById('searchResultsSection').classList.add('hidden');
    document.getElementById('searchInput').value = '';
    await cargarMisPeliculas();
}

async function borrarPelicula(id, titulo) {
    if (confirm(`¿Estás seguro de que quieres eliminar "${titulo}"?`)) {
        try {
            await pb.collection(window.CONFIG.COLLECTION_NAME).delete(id);
            cerrarDetalle();
        } catch (error) {
            console.error('Error al eliminar:', error);
        }
    }
}

function mostrarFinishModal() {
    ratingSeleccionado = 0;
    document.querySelectorAll('.star').forEach(s => s.classList.remove('active'));
    document.getElementById('finishNotes').value = peliculaActual.comentarios || '';
    if (peliculaActual.rated) {
        ratingSeleccionado = peliculaActual.rated;
        document.querySelectorAll('.star').forEach(s => {
            if (parseInt(s.getAttribute('data-value')) <= ratingSeleccionado) s.classList.add('active');
        });
    }
    document.getElementById('finishModal').style.display = 'flex';
}

function cerrarFinishModal() {
    document.getElementById('finishModal').style.display = 'none';
}

async function guardarFinalizacion() {
    if (!peliculaActual || !peliculaActual.id) return;
    const notas = document.getElementById('finishNotes').value;
    try {
        await pb.collection(window.CONFIG.COLLECTION_NAME).update(peliculaActual.id, {
            rated: ratingSeleccionado,
            comentarios: notas
        });
        peliculaActual.rated = ratingSeleccionado;
        peliculaActual.comentarios = notas;
        cerrarFinishModal();
        mostrarDetalle(peliculaActual, true);
    } catch (e) {
        alert("Error al guardar: " + e.message);
    }
}

updateAuthUI();
initStars();
document.getElementById('searchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') buscarPeliculas();
});
