// app.js — Motor OFF bloquea pedales y congela tacómetros/lecturas
// Controles: E (motor), ↑ (acelerar), ↓ (frenar), ←/→ (direccionales), H (hazard), R (reset trip)

(() => {
  // --- DOM ---
  const accEl   = document.getElementById('accVal');
  const spdEl   = document.getElementById('spdVal');
  const consEl  = document.getElementById('consVal');
  const consUnitEl = document.getElementById('consUnit');
  const unitToggle = document.getElementById('unitToggle');
  const soundToggle = document.getElementById('soundToggle');

  const rpmEl   = document.getElementById('rpmVal');
  const tachFill= document.getElementById('tachFill');

  const needle      = document.getElementById('needle');       // acelerómetro
  const speedNeedle = document.getElementById('speedNeedle');  // velocímetro
  const fuelEl  = document.getElementById('fuelFill');
  const odoEl   = document.getElementById('odoVal');
  const tripEl  = document.getElementById('tripVal');

  const engineBtn = document.getElementById('engineBtn');
  const accelBtn  = document.getElementById('accelBtn');
  const brakeBtn  = document.getElementById('brakeBtn');

  const leftBtn   = document.getElementById('leftBtn');
  const rightBtn  = document.getElementById('rightBtn');
  const hazardBtn = document.getElementById('hazardBtn');

  const resetBt   = document.getElementById('resetBtn');
  const sigLeft   = document.getElementById('sigLeft');
  const sigRight  = document.getElementById('sigRight');
  const engineLed = document.getElementById('engineLed');

  // --- Parámetros de simulación ---
  const Hz = 20;                   // 20 updates por segundo
  const dt = 1 / Hz;
  const G  = 9.81;
  const MAX_G = 2;
  const MAX_SPEED = 55;            // m/s (~198 km/h)
  const SPEEDOMETER_MAX_KMH = 200; // escala visual del velocímetro
  const FUEL_CAPACITY_L = 50;
  const BASE_L100 = 6;             // L/100km base
  const CONSUMPTION_K_A = 2.5;
  const CONSUMPTION_K_V = 1.2;

  // Tacómetro
  const RPM_IDLE = 800;
  const RPM_BRAKE = 900;
  const RPM_CRUISE = 1200;
  const RPM_MAX = 5000;
  const RPM_ACCEL = 3500;

  // --- Estado ---
  let engineOn = false;
  let accelHeld = false;
  let brakeHeld = false;

  let leftOn = false;
  let rightOn = false;
  let hazardOn = false;

  let useKmPerL = false; // false: L/100km (default), true: km/L
  let soundOn = false;

  let odoKm  = 123456.7;
  let tripKm = 12.3;
  let fuelL  = FUEL_CAPACITY_L * 0.60;

  let accel_g = 0;       // aceleración en g
  let target_g = 0;      // objetivo de aceleración
  let speed_mps = 0;     // velocidad
  let cons_l100 = BASE_L100;
  let consEMA   = BASE_L100;

  let rpm = 0;
  let rpmTarget = 0;

  // Reloj de parpadeo
  let blinkOn = false;

  // --- Utils ---
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const lerp  = (a, b, t) => a + (b - a) * t;

  const fmt1 = (num) => num.toLocaleString('es-MX', {minimumFractionDigits:1, maximumFractionDigits:1});
  const fmt0 = (num) => num.toLocaleString('es-MX', {maximumFractionDigits:0});
  const fmtTrip = (km) => {
    const entero = Math.floor(km);
    const frac   = Math.abs(km - entero);
    const entStr = String(entero).padStart(3, '0');
    const fracStr = Math.round(frac * 10);
    return `${entStr}.${fracStr}`;
  };

  // Cancelar animación CSS de agujas (controladas por JS)
  if (needle) needle.style.animation = 'none';

  // --- Audio ---
  let audioCtx = null;
  function ensureAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  function beep(freq = 880, ms = 100, vol = 0.07){
    if (!soundOn || !audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square'; osc.frequency.value = freq; gain.gain.value = vol;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(); setTimeout(()=>osc.stop(), ms);
  }
  const unlockAudio = () => { ensureAudio(); window.removeEventListener('click', unlockAudio); window.removeEventListener('keydown', unlockAudio); };
  window.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  // --- Helpers de UI ---
  function updatePedalsDisabled() {
    accelBtn.disabled = !engineOn;
    brakeBtn.disabled = !engineOn;
  }

  // --- Motor ---
  function setEngine(on) {
    engineOn = on;
    engineBtn.setAttribute('aria-pressed', String(on));
    engineBtn.textContent = on ? '🔴 Apagar motor' : '🟢 Encender motor';
    engineLed.classList.toggle('on', on);
    updatePedalsDisabled();

    if (on) {
      // Arranque
      rpmTarget = RPM_IDLE;
      target_g = 0;
      beep(420, 120, 0.09);
    } else {
      // Apagar: soltar pedales y CONGELAR lectura y movimiento
      accelHeld = false; brakeHeld = false;
      rpmTarget = 0;
      accel_g = 0;
      target_g = 0;
      speed_mps = 0;
      beep(280, 140, 0.08);

      // Forzar vistas a cero inmediatamente
      if (needle) needle.style.transform = `translateX(-50%) rotate(0deg)`;          // acelerómetro a 0
      if (speedNeedle) speedNeedle.style.transform = `translateX(-50%) rotate(-60deg)`; // velocímetro a 0 (ángulo inicial)
      if (accEl) accEl.textContent = '+0.00';
      if (spdEl) spdEl.textContent = '0';
    }
  }
  engineBtn?.addEventListener('click', () => setEngine(!engineOn));

  // --- Pedales ---
  function pressAccel(on){
    if (!engineOn) return;           // ignorar si motor apagado
    accelHeld = on;
    if (on) target_g = 0.6; else if (!brakeHeld) target_g = 0;
    rpmTarget = on ? RPM_ACCEL : (engineOn ? RPM_CRUISE : 0);
  }
  function pressBrake(on){
    if (!engineOn) return;           // ignorar si motor apagado
    brakeHeld = on;
    if (on) target_g = -0.9; else if (!accelHeld) target_g = 0;
    if (!accelHeld) rpmTarget = engineOn ? RPM_BRAKE : 0;
  }
  const onHold = (el, downFn, upFn) => {
    el?.addEventListener('mousedown', () => downFn(true));
    el?.addEventListener('mouseup',   () => upFn(false));
    el?.addEventListener('mouseleave',() => upFn(false));
    el?.addEventListener('touchstart', (e) => { e.preventDefault(); downFn(true); }, {passive:false});
    el?.addEventListener('touchend',   () => upFn(false));
    el?.addEventListener('touchcancel',() => upFn(false));
  };
  onHold(accelBtn, pressAccel, pressAccel);
  onHold(brakeBtn, pressBrake, pressBrake);

  // --- Direccionales / hazard ---
  function setLeft(on){ leftOn = on; leftBtn?.setAttribute('aria-pressed', String(on)); if (on) { setRight(false); setHazard(false); } }
  function setRight(on){ rightOn = on; rightBtn?.setAttribute('aria-pressed', String(on)); if (on) { setLeft(false); setHazard(false); } }
  function setHazard(on){
    hazardOn = on; hazardBtn?.setAttribute('aria-pressed', String(on));
    if (on) { leftOn = false; rightOn = false; leftBtn?.setAttribute('aria-pressed','false'); rightBtn?.setAttribute('aria-pressed','false'); }
  }
  leftBtn?.addEventListener('click', () => setLeft(!leftOn));
  rightBtn?.addEventListener('click', () => setRight(!rightOn));
  hazardBtn?.addEventListener('click', () => setHazard(!hazardOn));

  // Blink (direccionales/hazard)
  setInterval(() => {
    const prev = blinkOn;
    blinkOn = !blinkOn;
    if (hazardOn) {
      sigLeft?.classList.toggle('on', blinkOn);
      sigRight?.classList.toggle('on', blinkOn);
    } else {
      sigLeft?.classList.toggle('on', leftOn && blinkOn);
      sigRight?.classList.toggle('on', rightOn && blinkOn);
    }
    if (blinkOn && !prev && soundOn && (hazardOn || leftOn || rightOn)) beep(940, 70, 0.06);
  }, 500);

  // --- Reset Trip ---
  resetBt?.addEventListener('click', () => {
    tripKm = 0;
    resetBt.disabled = true; resetBt.style.cursor = 'not-allowed';
    setTimeout(() => { resetBt.disabled = false; resetBt.style.cursor = ''; }, 300);
  });

  // --- Unidades y sonido ---
  function setUnits(kmPerL){ useKmPerL = kmPerL; consUnitEl.textContent = kmPerL ? ' km/L' : ' L/100 km'; }
  unitToggle?.addEventListener('change', (e) => setUnits(e.target.checked));
  setUnits(false);

  function setSound(on){ soundOn = on; }
  soundToggle?.addEventListener('change', (e) => setSound(e.target.checked));
  setSound(false);

  // --- Teclado ---
  const keyState = new Set();
  window.addEventListener('keydown', (e) => {
    if (keyState.has(e.code)) return;
    keyState.add(e.code);
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();

    if (e.code === 'KeyE') setEngine(!engineOn);
    if (e.code === 'ArrowUp')   pressAccel(true);   // ignorará si motor apagado
    if (e.code === 'ArrowDown') pressBrake(true);   // ignorará si motor apagado
    if (e.code === 'ArrowLeft') setLeft(!leftOn);
    if (e.code === 'ArrowRight')setRight(!rightOn);
    if (e.code === 'KeyH')      setHazard(!hazardOn);
    if (e.code === 'KeyR')      resetBt?.click();
  });
  window.addEventListener('keyup', (e) => {
    keyState.delete(e.code);
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
    if (e.code === 'ArrowUp')   pressAccel(false);
    if (e.code === 'ArrowDown') pressBrake(false);
  });

  // --- Bucle principal ---
  setInterval(() => {
    // Si el motor está APAGADO: congelar todo en cero y salir.
    if (!engineOn) {
      accel_g = 0;
      target_g = 0;
      speed_mps = 0;
      rpm = lerp(rpm, 0, 0.2); // cae a 0 rápido

      // Vistas en 0
      if (needle) needle.style.transform = `translateX(-50%) rotate(0deg)`;
      if (speedNeedle) speedNeedle.style.transform = `translateX(-50%) rotate(-60deg)`; // 0 km/h
      if (accEl) accEl.textContent = '+0.00';
      if (spdEl) spdEl.textContent = '0';
      if (consEl) consEl.textContent = '—';
      if (rpmEl) rpmEl.textContent = fmt0(rpm);
      if (tachFill) tachFill.style.width = `${clamp(rpm / RPM_MAX,0,1)*100}%`;

      // odómetro y trip NO cambian, combustible NO cambia
      return; // salir del tick
    }

    // 1) Suavizado de aceleración hacia target
    accel_g = lerp(accel_g, target_g, 0.06);
    accel_g = clamp(accel_g, -MAX_G, MAX_G);

    // 2) Velocidad
    const a_mps2 = accel_g * G;
    const nextSpeed = speed_mps + a_mps2 * dt;
    speed_mps = clamp(nextSpeed, 0, MAX_SPEED);

    // 3) Distancia
    const d_km = (speed_mps * dt) / 1000;
    odoKm  += d_km;
    tripKm += d_km;

    // 4) Consumo (modelo simple)
    const v_rel = speed_mps / MAX_SPEED;
    let inst_l100 = BASE_L100 + CONSUMPTION_K_A * Math.abs(accel_g) + CONSUMPTION_K_V * v_rel;
    const moving = speed_mps > 0.5;
    if (!moving) inst_l100 = BASE_L100;

    const alpha = 0.15;
    consEMA = alpha * inst_l100 + (1 - alpha) * consEMA;
    cons_l100 = consEMA;

    if (moving) {
      const usedL = (inst_l100 * d_km) / 100;
      fuelL = Math.max(0, fuelL - usedL);
    }

    // 5) Tacómetro
    const speedBonus = Math.min(900, speed_mps * 20);
    let baseTarget = RPM_IDLE;
    if (accelHeld) baseTarget = RPM_ACCEL;
    else if (brakeHeld) baseTarget = RPM_BRAKE;
    else baseTarget = RPM_CRUISE;
    rpm = lerp(rpm, clamp(baseTarget + speedBonus, 0, RPM_MAX), 0.08);

    // 6) Vistas
    // Acelerómetro (aguja)
    const degAcc = (accel_g / MAX_G) * 60;
    if (needle) needle.style.transform = `translateX(-50%) rotate(${degAcc.toFixed(1)}deg)`;

    // Velocímetro (aguja)
    const kmh = speed_mps * 3.6;
    const kmhClamped = clamp(kmh, 0, SPEEDOMETER_MAX_KMH);
    const degSpd = (kmhClamped / SPEEDOMETER_MAX_KMH) * 120 - 60;
    if (speedNeedle) speedNeedle.style.transform = `translateX(-50%) rotate(${degSpd.toFixed(1)}deg)`;

    // Números
    if (accEl) {
      const acc_ms2 = accel_g * G;
      const sign = acc_ms2 >= 0 ? '+' : '';
      accEl.textContent = `${sign}${acc_ms2.toFixed(2)}`;
    }
    if (spdEl) spdEl.textContent = fmt0(kmh);

    // Consumo (unidad dinámica)
    if (consEl) {
      if (moving) {
        if (useKmPerL) {
          const kmPerL = (cons_l100 > 0) ? (100 / cons_l100) : 0;
          consEl.textContent = fmt1(kmPerL);
        } else {
          consEl.textContent = fmt1(cons_l100);
        }
      } else {
        consEl.textContent = '—';
      }
    }

    // Odómetro y Trip
    if (odoEl)  odoEl.innerHTML  = `${fmt1(odoKm)} <small>km</small>`;
    if (tripEl) tripEl.innerHTML = `${fmtTrip(tripKm)} <small>km</small>`;

    // Combustible (barra)
    if (fuelEl) {
      const fuelPct = clamp(fuelL / FUEL_CAPACITY_L, 0, 1);
      fuelEl.style.width = `${Math.round(fuelPct * 100)}%`;
      fuelEl.style.background = fuelPct < 0.15
        ? 'linear-gradient(90deg, #ef4444, #f59e0b)'
        : '';
    }

    // RPM (número + barra)
    if (rpmEl) rpmEl.textContent = fmt0(rpm);
    if (tachFill) {
      const pct = clamp(rpm / RPM_MAX, 0, 1) * 100;
      tachFill.style.width = `${pct.toFixed(0)}%`;
    }
  }, 1000 / Hz);

  // Inicial: pedales deshabilitados porque motor OFF
  updatePedalsDisabled();
})();
