// --- CONSTANTS & CONFIGURATION ---
const ESP32_API = "http://192.168.4.1/api/data";
const BUZZER_API = "http://192.168.4.1/api/buzz";
const EMERGENCY_API = "http://192.168.4.1/api/emergency-toggle";
const STORAGE_KEY = "smartPlantLastData";

// Audio Context for the virtual synthesizer
let audioCtx = null;

// Dashboard States
let dashboardMode = "live"; // "live" or "demo"
let countdownTimer = 1.0;   // 1 second polling countdown
let countdownIntervalId = null;
let countdownLastTick = Date.now(); // Common timestamp shared by countdown widgets
let simPumpWaitTimer = 0;           // Simulated patience timer for WAIT cooldown state
let soilHistory = [];               // Soil telemetry timeline records to calculate drying vectors

// Interactive Simulator State (starts with balanced premium defaults)
let simState = {
  soil: 45,
  soilStatus: "OK",
  pump: "OFF",
  water: 72,
  tankStatus: "OK",
  temperature: 24.5,
  humidity: 55,
  touch: 0,
  ir: 0,
  emergency: 0
};

// --- INITIALIZATION ---
document.addEventListener("DOMContentLoaded", () => {
  // Set up live HSL clock updating
  initLiveClock();
  
  // Set up 3D card tilt tracking (Butter smooth micro-interactions)
  init3DTilt();
  
  // Set up countdown timer rendering
  initCountdownTimer();
  
  // Load initial dataset (Live or Simulator)
  loadPlantData();
  
  // Start the 1-second telemetry polling loop
  setInterval(loadPlantData, 1000);
  
  // Add terminal entry
  appendConsoleLine("SYS", "BioSphera Sentinel ready. Mode initialized: LIVE ESP32 telemetry.", "success");
});

// --- AUDIO ALERT SYNTHESIS (Web Audio API) ---
function playBeep(frequency = 880, duration = 0.15, type = "sine") {
  try {
    // Create AudioContext lazily on user interaction
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);
    
    // Smooth volume fade-out to prevent clicks
    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
    
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + duration);
  } catch (err) {
    console.warn("Audio Context block or unsupported browser: ", err);
  }
}

// Low Water audible alert
function triggerSynthesizedAlert() {
  playBeep(440, 0.18, "sawtooth");
  setTimeout(() => playBeep(330, 0.22, "sawtooth"), 150);
}

// --- USER REQUESTED CORE TELEMETRY FUNCTIONS ---

async function fetchWithTimeout(url, timeout = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      cache: "no-store"
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error("ESP32 API error");
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

function saveLastData(data) {
  const savedData = {
    ...data,
    savedAt: new Date().toLocaleString()
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedData));
}

function getLastData() {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? JSON.parse(saved) : null;
}

// // Extends the requested updateDashboard to support our stunning, 3D interactive layout!
function updateDashboard(data, isLive) {
  // Bind standard requested parameters
  document.getElementById("soil").innerText = data.soil + "%";
  document.getElementById("soilStatus").innerText = data.soilStatus;
  document.getElementById("pump").innerText = data.pump;

  document.getElementById("water").innerText = data.water + "%";
  document.getElementById("tankStatus").innerText = data.tankStatus;

  document.getElementById("temperature").innerText = data.temperature + "°C";
  document.getElementById("humidity").innerText = data.humidity + "%";

  document.getElementById("touch").innerText = data.touch;
  document.getElementById("ir").innerText = data.ir;
  
  updateEmergencyUI(data.emergency);

  const status = document.getElementById("connectionStatus");
  const lastUpdate = document.getElementById("lastUpdate");

  if (isLive) {
    status.innerText = "LIVE";
    status.className = "status live";
    lastUpdate.innerText = "Updated now";
  } else {
    status.innerText = "OFFLINE - Showing Last Saved Data";
    status.className = "status offline";
    lastUpdate.innerText = data.savedAt
      ? "Last updated: " + data.savedAt
      : "Last update not available";
  }

  // --- BIO-SPHERA ADVANCED UI GAUGE RENDERING ---
  
  // 1. Soil circular progress ring (dasharray: 377)
  const soilPercent = parseInt(data.soil) || 0;
  const soilRing = document.getElementById("soilRing");
  const soilOffset = 377 - (377 * soilPercent) / 100;
  soilRing.style.strokeDashoffset = soilOffset;
  
  // Custom color-shifting depending on soil status
  if (data.soilStatus === "DRY") {
    soilRing.style.stroke = "var(--color-soil-dry)";
    document.documentElement.style.setProperty('--color-soil', 'var(--color-soil-dry)');
  } else if (data.soilStatus === "WET") {
    soilRing.style.stroke = "var(--color-soil-wet)";
    document.documentElement.style.setProperty('--color-soil', 'var(--color-soil-wet)');
  } else {
    soilRing.style.stroke = "hsl(135, 59%, 49%)";
    document.documentElement.style.setProperty('--color-soil', 'hsl(135, 59%, 49%)');
  }

  // 2. Pump fan rotater (supports ON, WAIT, OFF)
  const pumpBadge = document.getElementById("pumpBadge");
  if (data.pump === "ON") {
    pumpBadge.classList.add("active");
    pumpBadge.classList.remove("wait");
  } else if (data.pump === "WAIT") {
    pumpBadge.classList.remove("active");
    pumpBadge.classList.add("wait");
  } else {
    pumpBadge.classList.remove("active");
    pumpBadge.classList.remove("wait");
  }

  // 3. Water tank height visualizer (0-100%)
  const waterPercent = parseInt(data.water) || 0;
  const tankLiquid = document.getElementById("tankLiquid");
  tankLiquid.style.height = waterPercent + "%";
  
  // Trigger audible buzzer chirp if tank runs LOW
  if (data.tankStatus === "LOW" && dashboardMode === "live") {
    triggerSynthesizedAlert();
  }

  // 4. Atmosphere Dial rendering (dasharray: 220)
  const tempVal = parseFloat(data.temperature) || 0;
  const humVal = parseFloat(data.humidity) || 0;
  
  const tempRing = document.getElementById("tempRing");
  const tempOffset = 220 - (220 * Math.min(tempVal, 50)) / 50; // max scale 50°C
  tempRing.style.strokeDashoffset = tempOffset;

  const humRing = document.getElementById("humRing");
  const humOffset = 220 - (220 * humVal) / 100;
  humRing.style.strokeDashoffset = humOffset;

  // Temperature evaluation pill
  const tempPill = document.getElementById("tempPill");
  if (tempVal > 30) {
    tempPill.innerText = "Hot Environment";
    tempPill.className = "status-pill hot";
  } else if (tempVal < 18) {
    tempPill.innerText = "Chilly Environment";
    tempPill.className = "status-pill cold";
  } else {
    tempPill.innerText = "Comfortable";
    tempPill.className = "status-pill comfortable";
  }

  // Humidity evaluation pill
  const humPill = document.getElementById("humPill");
  if (humVal > 70) {
    humPill.innerText = "Damp Atmosphere";
    humPill.className = "status-pill cold";
  } else if (humVal < 35) {
    humPill.innerText = "Dry Atmosphere";
    humPill.className = "status-pill hot";
  } else {
    humPill.innerText = "Healthy Humidity";
    humPill.className = "status-pill comfortable";
  }

  // 5. Cap Touch & Proximity Peripherals
  const panelTouch = document.getElementById("panelTouch");
  const visualTouch = document.getElementById("visualTouch");
  const bubbleTouch = document.getElementById("bubbleTouch");
  
  if (data.touch == 1) {
    panelTouch.classList.add("active");
    visualTouch.classList.add("active");
    bubbleTouch.classList.add("active");
    
    // Play synthesis chime when touched!
    if (Math.random() < 0.15) {
      playBeep(1200, 0.08, "triangle");
      setTimeout(() => playBeep(1500, 0.1, "sine"), 80);
    }
  } else {
    panelTouch.classList.remove("active");
    visualTouch.classList.remove("active");
    bubbleTouch.classList.remove("active");
  }

  const panelIR = document.getElementById("panelIR");
  const visualIR = document.getElementById("visualIR");
  const bubbleIR = document.getElementById("bubbleIR");
  const radarOverlay = document.getElementById("radarOverlay");
  
  if (data.ir == 1) {
    panelIR.classList.add("active");
    visualIR.classList.add("active");
    bubbleIR.classList.add("active");
    radarOverlay.classList.add("active");
  } else {
    panelIR.classList.remove("active");
    visualIR.classList.remove("active");
    bubbleIR.classList.remove("active");
    radarOverlay.classList.remove("active");
  }

  // --- 6. DYNAMIC 3D SVG PLANT STATES ---
  
  // Determine plant styles based on moisture
  let leafColor = "#3bca6c";
  let stemColor = "#2da154";
  let droopLeft = "0deg";
  let droopRight = "0deg";
  let plantGlow = "rgba(0, 0, 0, 0)";
  
  if (data.soilStatus === "DRY") {
    leafColor = "#b1b854";  // pale yellowish-green
    stemColor = "#778028";
    droopLeft = "14deg";    // droop left leaves downwards (clockwise)
    droopRight = "-14deg";  // droop right leaves downwards (counter-clockwise)
    plantGlow = "rgba(245, 158, 11, 0.15)";
  } else if (data.soilStatus === "WET") {
    leafColor = "#1f877c";  // dark saturated teal
    stemColor = "#115c54";
    droopLeft = "-4deg";    // stand left leaves upright (counter-clockwise)
    droopRight = "4deg";    // stand right leaves upright (clockwise)
    plantGlow = "rgba(6, 182, 212, 0.15)";
  } else {
    // Normal healthy plant
    leafColor = "#3bca6c";
    stemColor = "#2da154";
    droopLeft = "0deg";
    droopRight = "0deg";
    plantGlow = "rgba(59, 202, 108, 0.18)";
  }

  // System emergency state visual reaction (fancy warning overrides)
  if (data.emergency == 1 || data.emergency === true) {
    leafColor = "#8e9196";  // Gray/inactive leaves
    stemColor = "#545a63";
    droopLeft = "22deg";    // Fully droop left leaves down
    droopRight = "-22deg";  // Fully droop right leaves down
    plantGlow = "rgba(239, 68, 68, 0.35)"; // Alarm red background glow!
  }

  // Adjust css vars dynamically
  const root = document.documentElement;
  root.style.setProperty('--plant-leaf-color', leafColor);
  root.style.setProperty('--plant-stem-color', stemColor);
  root.style.setProperty('--plant-droop-deg-left', droopLeft);
  root.style.setProperty('--plant-droop-deg-right', droopRight);
  
  // Custom glowing reactions
  const plantBackdrop = document.getElementById("plantGlowBackdrop");
  plantBackdrop.style.background = `radial-gradient(circle, ${plantGlow} 0%, transparent 70%)`;
  
  const plantSvg = document.getElementById("virtual-plant");
  const touchRipple = document.getElementById("touchRipple");
  
  if (data.touch == 1) {
    plantSvg.classList.add("touch-active-glow");
    
    // Animate glowing ripples around the pot
    touchRipple.style.opacity = "1";
    touchRipple.style.transform = "scale(2.2)";
    
    // Sway the flower bud quickly
    root.style.setProperty('--plant-flower-color', '#ff3377');
  } else {
    plantSvg.classList.remove("touch-active-glow");
    touchRipple.style.opacity = "0";
    touchRipple.style.transform = "scale(0.5)";
    root.style.setProperty('--plant-flower-color', '#ff5e97');
  }
  
  // Trigger AI Prognostics & Expert analysis
  updateAIBotanicalAdvisor(data, isLive);
}

// The core requested loadPlantData routine, reinforced with Simulator overrides!
async function loadPlantData() {
  // Restart our 2-second visual countdown wheel
  resetCountdown();

  // 1. If running in Simulated Demo mode
  if (dashboardMode === "demo") {
    // Handle simulated WAIT cooldown period
    if (simState.pump === "WAIT") {
      simPumpWaitTimer--;
      if (simPumpWaitTimer <= 0) {
        simState.pump = "OFF";
        appendConsoleLine("SIM", `Cooldown complete. Checking soil matrix again.`, "success");
      }
    }

    // Simulate pump logic: if soil moisture is DRY (<35), trigger simulated pump ON
    if (simState.soil < 35 && simState.pump !== "WAIT") {
      if (simState.emergency == 1) {
        simState.pump = "OFF";
        appendConsoleLine("SIM", `Pump trigger BLOCKED: System is under EMERGENCY SHUTDOWN.`, "error");
      } else if (simState.water >= 15) {
        simState.pump = "ON";
        // Wet the soil gradually
        simState.soil = Math.min(simState.soil + 10, 100);
        // Deplete the water tank
        simState.water = Math.max(simState.water - 5, 0);
        appendConsoleLine("SIM", `Ground moisture critical! Pump activated. Watering plant...`, "warn");
        // Play soft pump buzz sound
        playBeep(180, 0.4, "square");
      } else {
        simState.pump = "OFF";
        simState.tankStatus = "LOW";
        appendConsoleLine("SIM", `ALERT: Irrigation requested but reservoir is EMPTY. Refill required.`, "error");
        triggerSynthesizedAlert();
      }
    }

    // Transition from ON -> WAIT once soil reaches comfortable levels
    if (simState.pump === "ON" && simState.soil >= 55) {
      simState.pump = "WAIT";
      simPumpWaitTimer = 3; // Cooldown for 3 sweeps (3 seconds)
      appendConsoleLine("SIM", `Soil satisfied. Entering patience cooldown (WAIT state)...`, "info");
    }

    // Dynamic Soil status evaluator
    if (simState.soil < 35) {
      simState.soilStatus = "DRY";
    } else if (simState.soil > 60) {
      simState.soilStatus = "WET";
    } else {
      simState.soilStatus = "OK";
    }

    // Dynamic Tank status evaluator
    if (simState.water < 20) {
      simState.tankStatus = "LOW";
    } else if (simState.water > 80) {
      simState.tankStatus = "FULL";
    } else {
      simState.water = Math.max(simState.water, 0);
      simState.tankStatus = "OK";
    }

    // Sync HTML Simulator Sliders text
    document.getElementById("simSoilVal").innerText = simState.soil + "%";
    document.getElementById("simWaterVal").innerText = simState.water + "%";
    document.getElementById("simTempVal").innerText = simState.temperature + "°C";
    document.getElementById("simHumVal").innerText = simState.humidity + "%";

    // Save and render simulated data
    saveLastData(simState);
    updateDashboard(simState, true);
    
    const packetPreview = `{"soil": ${simState.soil}, "soilStatus": "${simState.soilStatus}", "pump": "${simState.pump}", "water": ${simState.water}, "tankStatus": "${simState.tankStatus}"}`;
    appendConsoleLine("SIM", `Fetched simulated state: ${packetPreview}`, "success");
    return;
  }

  // 2. If running in Live ESP32 AP mode
  try {
    const startTime = performance.now();
    const liveData = await fetchWithTimeout(ESP32_API);
    const latency = Math.round(performance.now() - startTime);

    saveLastData(liveData);
    updateDashboard(liveData, true);

    appendConsoleLine("API", `HTTP GET 200 OK. Responded in ${latency}ms. Payload: ${JSON.stringify(liveData)}`, "success");
    console.log("Live ESP32 data:", liveData);
  } catch (error) {
    console.log("ESP32 offline, using saved data");
    appendConsoleLine("API", `ERR: ESP32 query timed out. Loading local storage fallback...`, "error");

    const lastData = getLastData();

    if (lastData) {
      updateDashboard(lastData, false);
      appendConsoleLine("SYS", `Offline cache restored. Displaying records from: ${lastData.savedAt || 'Unknown Date'}`, "warn");
    } else {
      document.getElementById("connectionStatus").innerText = "OFFLINE - No saved data available";
      document.getElementById("connectionStatus").className = "status offline";
      
      appendConsoleLine("SYS", `CRITICAL: System offline and no cached dashboard telemetry exists!`, "error");
      triggerSynthesizedAlert();
    }
  }
}

// --- INTERACTIVE SIMULATOR SLIDERS AND INTERRUPTS ---

// --- EMERGENCY CONTROL SYSTEM FUNCTIONS ---

async function toggleEmergency() {
  if (dashboardMode === "demo") {
    simState.emergency = simState.emergency === 1 ? 0 : 1;
    updateEmergencyUI(simState.emergency === 1);
    updateDashboard(simState, true);
    
    appendConsoleLine("SIM", `System Safety Interrupt: Emergency state toggled to ${simState.emergency === 1 ? 'ACTIVE (SHUTDOWN)' : 'NORMAL'}.`, "warn");
    playBeep(simState.emergency === 1 ? 220 : 660, 0.35, "sawtooth");
    return;
  }

  try {
    const response = await fetch(EMERGENCY_API, {
      method: "GET",
      cache: "no-store"
    });

    const data = await response.json();
    console.log("Emergency response:", data);

    updateEmergencyUI(data.emergency);

    loadPlantData();
  } catch (error) {
    console.log("Emergency toggle failed:", error);
    appendConsoleLine("API", "Emergency command failed. Connect to Smart_Plant_ESP32 Wi-Fi.", "error");
    alert("Emergency command failed. Connect to Smart_Plant_ESP32 Wi-Fi.");
  }
}

async function testBuzzer() {
  if (dashboardMode === "demo") {
    appendConsoleLine("SIM", "Simulated physical buzzer test triggered successfully.", "success");
    playBeep(880, 0.2, "sine");
    return;
  }

  try {
    const response = await fetch(BUZZER_API, {
      method: "GET",
      cache: "no-store"
    });

    const data = await response.json();
    console.log("Buzzer response:", data);

    if (data.success) {
      console.log("Buzzer tested successfully");
      appendConsoleLine("API", "Remote ESP32 buzzer tested successfully.", "success");
      playBeep(880, 0.2, "sine"); // Synthesize audio confirmation
    }
  } catch (error) {
    console.log("Buzzer test failed:", error);
    appendConsoleLine("API", "Buzzer test failed. Connect to Smart_Plant_ESP32 Wi-Fi.", "error");
    alert("Buzzer test failed. Connect to Smart_Plant_ESP32 Wi-Fi.");
  }
}

function updateEmergencyUI(isEmergency) {
  const emergencyText = document.getElementById("emergency");
  const emergencyBtn = document.getElementById("emergencyBtn");
  if (!emergencyText || !emergencyBtn) return;

  if (isEmergency) {
    emergencyText.innerText = "ACTIVE";
    emergencyText.style.color = "var(--color-offline)"; // Glowing alarm red
    
    emergencyBtn.innerText = "Resume System";
    emergencyBtn.style.background = "green";
    emergencyBtn.style.color = "white";
    emergencyBtn.style.boxShadow = "0 4px 15px rgba(16, 185, 129, 0.35)";
  } else {
    emergencyText.innerText = "NORMAL";
    emergencyText.style.color = "var(--text-muted)";
    
    emergencyBtn.innerText = "Emergency Shutdown";
    emergencyBtn.style.background = "red";
    emergencyBtn.style.color = "white";
    emergencyBtn.style.boxShadow = "0 4px 15px rgba(239, 68, 68, 0.35)";
  }
}

function setDashboardMode(mode) {
  dashboardMode = mode;
  
  const btnLive = document.getElementById("btnLiveMode");
  const btnDemo = document.getElementById("btnDemoMode");
  const simPanel = document.getElementById("simulatorPanel");
  
  if (mode === "demo") {
    btnLive.classList.remove("active");
    btnDemo.classList.add("active");
    simPanel.classList.add("visible");
    
    // Sync slider DOM handles to current simState values
    document.getElementById("inputSimSoil").value = simState.soil;
    document.getElementById("inputSimWater").value = simState.water;
    document.getElementById("inputSimTemp").value = simState.temperature;
    document.getElementById("inputSimHumidity").value = simState.humidity;
    
    appendConsoleLine("SYS", "Switched to Simulator Mode. Live polling suspended.", "warn");
    playBeep(660, 0.1, "sine");
  } else {
    btnLive.classList.add("active");
    btnDemo.classList.remove("active");
    simPanel.classList.remove("visible");
    
    appendConsoleLine("SYS", "Resumed connection to live ESP32 network bus...", "success");
    playBeep(880, 0.1, "sine");
  }
  
  loadPlantData();
}

function updateSimState(param, value) {
  if (param === 'soil') {
    simState.soil = parseInt(value);
  } else if (param === 'water') {
    simState.water = parseInt(value);
  } else if (param === 'temperature') {
    simState.temperature = parseFloat(value);
  } else if (param === 'humidity') {
    simState.humidity = parseInt(value);
  }
  
  // Re-run dashboard binder immediately for visual responsiveness
  updateDashboard(simState, true);
}

function toggleSimBinary(sensor) {
  const btnTouch = document.getElementById("btnSimTouch");
  const btnIR = document.getElementById("btnSimIR");
  
  if (sensor === 'touch') {
    simState.touch = simState.touch === 1 ? 0 : 1;
    btnTouch.innerText = `Touch (${simState.touch})`;
    btnTouch.className = simState.touch === 1 ? "sim-btn-pill active" : "sim-btn-pill";
    appendConsoleLine("SIM", `Hardware Interrupt: Cap Touch set to ${simState.touch}`, "info");
    playBeep(1000, 0.05, "triangle");
  } else if (sensor === 'ir') {
    simState.ir = simState.ir === 1 ? 0 : 1;
    btnIR.innerText = `IR (${simState.ir})`;
    btnIR.className = simState.ir === 1 ? "sim-btn-pill active" : "sim-btn-pill";
    appendConsoleLine("SIM", `Hardware Interrupt: Proximity IR set to ${simState.ir}`, "info");
    playBeep(600, 0.08, "triangle");
  }
  
  // Render updates instantly
  updateDashboard(simState, true);
}

// --- UTILITY WIDGETS AND EFFECTS ---

// Dynamic scrolling activity feed
function appendConsoleLine(source, message, type = "info") {
  const consoleLog = document.getElementById("consoleLog");
  if (!consoleLog) return;
  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  
  // Select icons based on event severity
  let icon = "fa-circle-info";
  if (type === "success") icon = "fa-check";
  else if (type === "error") icon = "fa-circle-xmark";
  else if (type === "warn") icon = "fa-circle-exclamation";
  
  const line = document.createElement("div");
  line.className = `feed-item ${type}`;
  
  line.innerHTML = `
    <div class="feed-icon-circle">
      <i class="fa-solid ${icon}"></i>
    </div>
    <div class="feed-item-content">
      <div class="feed-item-header">
        <span class="source-badge ${source.toLowerCase()}">${source}</span>
        <span class="time">${timeStr}</span>
      </div>
      <span class="message">${message}</span>
    </div>
  `;
  
  consoleLog.appendChild(line);
  
  // Max logs size of 30 to maintain visual clarity
  while (consoleLog.children.length > 30) {
    consoleLog.removeChild(consoleLog.firstChild);
  }
  
  // Smooth scroll feed list to the absolute bottom
  consoleLog.scrollTo({
    top: consoleLog.scrollHeight,
    behavior: 'smooth'
  });
}

function clearConsoleLog() {
  const consoleLog = document.getElementById("consoleLog");
  consoleLog.innerHTML = "";
  appendConsoleLine("SYS", "Telemetry log buffer cleared.", "info");
  playBeep(520, 0.05);
}

// 1-second HSL digital clock
function initLiveClock() {
  const clockElement = document.getElementById("liveClock");
  const dateElement = document.getElementById("liveDate");
  
  function tick() {
    const now = new Date();
    clockElement.innerText = now.toLocaleTimeString();
    
    // Formatting date neatly: "May 27, 2026 • Living Room"
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    dateElement.innerText = now.toLocaleDateString('en-US', options) + " • Living Room";
  }
  
  tick();
  setInterval(tick, 1000);
}

// Countdown timer circle loop (2s interval sync)
function initCountdownTimer() {
  const fill = document.getElementById("countdownFill");
  const label = document.getElementById("countdownSec");
  
  // Progress Ring logic (dasharray: 170)
  // We run a high-precision 100ms interval timer to slide the circle
  countdownLastTick = Date.now();
  
  function clockCountdown() {
    const elapsed = (Date.now() - countdownLastTick) / 1000;
    countdownTimer = Math.max(1.0 - elapsed, 0);
    
    label.innerText = countdownTimer.toFixed(1) + " seconds";
    
    // Animate dash offset: 170 to 0
    const offset = 170 - (170 * (countdownTimer / 1.0));
    fill.style.strokeDashoffset = offset;
    
    requestAnimationFrame(clockCountdown);
  }
  
  countdownLastTick = Date.now();
  clockCountdown();
}

function resetCountdown() {
  countdownTimer = 1.0;
  // Trigger a full restart on our elapsed timestamp
  const now = Date.now();
  // We can just query standard timings
  countdownLastTick = now;
}

// Butter-smooth mouse tilt tracking (Creates depth parallax effect!)
function init3DTilt() {
  const cards = document.querySelectorAll(".tiltable");
  
  cards.forEach(card => {
    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left; // x coordinate inside element
      const y = e.clientY - rect.top;  // y coordinate inside element
      
      const width = rect.width;
      const height = rect.height;
      
      // Calculate rotation multipliers (max rotation 6deg)
      const rotateX = ((y / height) - 0.5) * -12;
      const rotateY = ((x / width) - 0.5) * 12;
      
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
    });
    
    card.addEventListener("mouseleave", () => {
      card.style.transform = "perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)";
    });
  });
}

// --- EDGE-AI BOTANICAL ADVISOR DIAGNOSTIC SUITE ---

function updateAIBotanicalAdvisor(data, isLive) {
  const diagnosisText = document.getElementById("aiDiagnosisText");
  const suitablePlants = document.getElementById("aiSuitablePlants");
  const wateringPrediction = document.getElementById("aiWateringPrediction");
  const moistureTrend = document.getElementById("aiMoistureTrend");
  const faultList = document.getElementById("aiFaultList");
  
  if (!diagnosisText || !suitablePlants || !wateringPrediction || !moistureTrend || !faultList) return;
  
  // 1. Core variables
  const soilPercent = parseInt(data.soil) || 0;
  const tempVal = parseFloat(data.temperature) || 0;
  const humVal = parseFloat(data.humidity) || 0;
  const waterPercent = parseInt(data.water) || 0;
  const isEmergency = data.emergency == 1 || data.emergency === true;
  
  // 2. Trend vector & Soil history slope analysis (Step 15E)
  const now = Date.now();
  soilHistory.push({ value: soilPercent, time: now });
  
  // Maintain a maximum of 30 historical sweeps (30 seconds of rolling telemetry)
  if (soilHistory.length > 30) {
    soilHistory.shift();
  }
  
  let ratePerMinute = 0;
  if (soilHistory.length >= 5) {
    const first = soilHistory[0];
    const last = soilHistory[soilHistory.length - 1];
    const timeDeltaSec = (last.time - first.time) / 1000;
    const valDelta = last.value - first.value;
    ratePerMinute = timeDeltaSec > 0 ? (valDelta / timeDeltaSec) * 60 : 0;
  }
  
  // Display dynamic drying trend vectors (Step 15E)
  if (ratePerMinute < -0.05) {
    moistureTrend.innerHTML = `<span style="color: hsl(38, 92%, 50%);"><i class="fa-solid fa-circle-down"></i> Drying (-${Math.abs(ratePerMinute).toFixed(1)}%/min)</span>`;
  } else if (ratePerMinute > 0.05) {
    moistureTrend.innerHTML = `<span style="color: #60a5fa;"><i class="fa-solid fa-circle-up"></i> Hydrating (+${ratePerMinute.toFixed(1)}%/min)</span>`;
  } else {
    moistureTrend.innerHTML = `<span style="color: var(--color-live);"><i class="fa-solid fa-circle-check"></i> Stable (No slope)</span>`;
  }
  
  // 3. Next watering countdown prediction (Step 15D)
  if (data.pump === "ON") {
    wateringPrediction.innerText = "Active irrigation cycle in progress";
    wateringPrediction.style.color = "var(--color-pump-on)";
  } else if (data.pump === "WAIT") {
    wateringPrediction.innerText = "Safety wait state active (cooldown)...";
    wateringPrediction.style.color = "hsl(38, 92%, 50%)";
  } else if (isEmergency) {
    wateringPrediction.innerText = "System suspended (Safety Shutdown)";
    wateringPrediction.style.color = "var(--color-offline)";
  } else if (ratePerMinute < -0.02) {
    const remainingToDry = soilPercent - 35; // watering trigger threshold is 35%
    if (remainingToDry <= 0) {
      wateringPrediction.innerText = "Moisture limit breached. Watering imminent.";
      wateringPrediction.style.color = "var(--color-offline)";
    } else {
      const minutesToDry = remainingToDry / Math.abs(ratePerMinute);
      if (minutesToDry < 1) {
        wateringPrediction.innerText = "Estimated in less than a minute";
      } else {
        wateringPrediction.innerText = `Estimated in ${Math.round(minutesToDry)} minutes`;
      }
      wateringPrediction.style.color = "#fff";
    }
  } else {
    wateringPrediction.innerText = "Stable - Soil drying rate negligible";
    wateringPrediction.style.color = "var(--text-muted)";
  }
  
  // 4. System safety fault matrix diagnostics (Step 15C)
  faultList.innerHTML = "";
  let faults = [];
  
  if (!isLive) {
    faults.push({ text: "ESP32 offline - restyling log cache", level: "danger", icon: "fa-wifi-slash" });
  }
  if (isEmergency) {
    faults.push({ text: "Active Safety Lock: Irrigation motor fully cut off", level: "danger", icon: "fa-triangle-exclamation" });
  }
  if (waterPercent < 20) {
    faults.push({ text: "Reservoir alert: Tank depleted (Refill required)", level: "danger", icon: "fa-circle-exclamation" });
  }
  if (data.soilStatus === "DRY") {
    faults.push({ text: "Ground moisture limit deficient (dehydration risk)", level: "warning", icon: "fa-droplet-slash" });
  } else if (data.soilStatus === "WET") {
    faults.push({ text: "Soil overwatering threshold exceeded (root-rot hazard)", level: "warning", icon: "fa-water" });
  }
  if (tempVal > 32) {
    faults.push({ text: "Climate Alert: High ambient heat stress detected", level: "warning", icon: "fa-fire" });
  } else if (tempVal < 16) {
    faults.push({ text: "Climate Alert: Low temperature frost hazard warning", level: "warning", icon: "fa-snowflake" });
  }
  
  // Render fault elements
  if (faults.length === 0) {
    const item = document.createElement("li");
    item.className = "fault-item ok";
    item.innerHTML = `<i class="fa-solid fa-shield-halved"></i> Diagnostics secure. System vitals optimal.`;
    faultList.appendChild(item);
  } else {
    faults.forEach(f => {
      const item = document.createElement("li");
      item.className = `fault-item ${f.level}`;
      item.innerHTML = `<i class="fa-solid ${f.icon}"></i> ${f.text}`;
      faultList.appendChild(item);
    });
  }
  
  // 5. Real-Time AI Botanical Diagnosis advisor advice (Step 15B)
  if (isEmergency) {
    diagnosisText.innerText = "SYSTEM REACTION: Biosphera AI Core detects active Emergency Shutdown command. Automation loops, safety monitoring, and pump triggers are locked off. Resume system to restore botanical care routines.";
  } else if (soilPercent < 35 && waterPercent < 20) {
    diagnosisText.innerText = `CRITICAL FAULT: Groundwater levels are severely deficient (${soilPercent}%), but the reservoir is fully depleted (${waterPercent}%). Pump is locked for motor safety. Refill reservoir immediately to save roots!`;
  } else if (soilPercent < 35) {
    diagnosisText.innerText = `HYDRATION ALERT: Ground moisture is deficient (${soilPercent}%). Irrigation motor is currently active to irrigate root structures. Waiting safety loop cooldown.`;
  } else if (soilPercent > 60) {
    diagnosisText.innerText = `OVERWATERING DANGER: Groundwater saturation has reached maximum bounds (${soilPercent}%). Suspended all irrigation routines to protect secondary root structures against rot.`;
  } else {
    diagnosisText.innerText = `VITALS ENERGETIC: Ground soil moisture is balanced at a healthy ${soilPercent}%. Ambient heat of ${tempVal}°C and ${humVal}% relative humidity is optimal for photosynthesis.`;
  }
  
  // 6. Suitable Plant Recommendations (Based on current temperature/humidity - Displays 5 options)
  suitablePlants.innerHTML = "";
  let plants = [];
  
  if (tempVal > 24 && humVal > 55) {
    plants = ["Areca Palm", "Tulsi (Holy Basil)", "Hibiscus (Gudhal)", "Boston Fern", "Monstera Deliciosa"];
  } else if (tempVal > 24 && humVal <= 55) {
    plants = ["Aloe Vera (Gwarpatha)", "Snake Plant", "Ashwagandha Herb", "Zebra Cactus", "Jade Succulent"];
  } else if (tempVal <= 18) {
    plants = ["SadaBahar (Periwinkle)", "Indian Mustard Green", "Brahmi Herb", "English Ivy", "Winter Pansy"];
  } else {
    plants = ["Indian Money Plant", "Tulsi (Holy Basil)", "Areca Palm", "Spider Plant", "Peace Lily"];
  }
  
  plants.forEach(p => {
    const badge = document.createElement("span");
    badge.className = "suitability-tag";
    badge.innerText = p;
    badge.style.cursor = "pointer";
    badge.title = `Click to ask AI Core about ${p} care!`;
    
    // Core interaction: clicking the badge triggers the local AI chatbot care guide!
    badge.onclick = () => {
      sendChatQuestion(`Tell me how to care for the ${p} in these current conditions?`);
    };
    
    suitablePlants.appendChild(badge);
  });
}

// --- AI BOTANICAL CO-PILOT CHATBOT SYSTEM (Step 15F) ---

function appendChatBubble(sender, text) {
  const feed = document.getElementById("aiChatFeed");
  if (!feed) return;
  
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble ${sender}`;
  bubble.innerText = text;
  
  feed.appendChild(bubble);
  
  // Smooth scroll feed container
  feed.scrollTo({
    top: feed.scrollHeight,
    behavior: 'smooth'
  });
}

function sendChatQuestion(questionText) {
  // Append user's question bubble
  appendChatBubble("user", questionText);
  playBeep(980, 0.08, "sine");
  
  // AI thinking delay
  setTimeout(() => {
    const reply = generateAICoreResponse(questionText);
    appendChatBubble("ai", reply);
    playBeep(640, 0.12, "triangle");
  }, 400);
}

function sendCustomChatQuery() {
  const input = document.getElementById("chatInput");
  if (!input) return;
  
  const text = input.value.trim();
  if (text === "") return;
  
  input.value = "";
  sendChatQuestion(text);
}

function generateAICoreResponse(query) {
  const q = query.toLowerCase();
  
  // Fetch current numbers for high-fidelity responses!
  const lastData = getLastData() || simState;
  
  if (q.includes("healthy") || q.includes("vital") || q.includes("status") || q.includes("check")) {
    if (lastData.emergency == 1) {
      return "Biosphera AI Core Audit: System under active emergency lock. Plant support systems cannot be optimized until safety is resumed.";
    }
    if (lastData.soilStatus === "DRY") {
      return `Biosphera AI Core Audit: Groundwater moisture is critical at ${lastData.soil}%. Plant is entering drought stress. Irrigation is active.`;
    }
    if (lastData.soilStatus === "WET") {
      return `Biosphera AI Core Audit: Groundwater moisture is high at ${lastData.soil}%. Watch out for over-watering. Ambient humidity is ${lastData.humidity}%.`;
    }
    return `Biosphera AI Core Audit: Vitals normal! Soil hydration is stable at ${lastData.soil}%, temperature is comfortable at ${lastData.temperature}°C, and reservoir level is secure at ${lastData.water}%.`;
  }
  
  if (q.includes("wait") || q.includes("cooldown") || q.includes("patience")) {
    return "The WAIT status represents a safety cooldown interval. After a pump watering cycle runs, the system pauses check routines for 10 seconds. This allows water to disperse evenly across the soil grid, preventing over-watering.";
  }
  
  if (q.includes("plant") || q.includes("grow") || q.includes("suitable")) {
    const t = parseFloat(lastData.temperature) || 24;
    const h = parseFloat(lastData.humidity) || 55;
    
    if (t > 24 && h > 55) {
      return `Current ambient conditions (${t}°C, ${h}% humidity) are warm and tropical. Excellent for growing Monsteras, Sword Ferns, Calatheas, and Orchids!`;
    }
    if (t > 24 && h <= 55) {
      return `Current ambient climate (${t}°C, ${h}% humidity) is warm and dry. Excellent for Cactus, Succulents, Snake Plants, and Aloe Vera!`;
    }
    return `Current ambient climate (${t}°C, ${h}% humidity) is temperate. This is perfectly balanced for growing Pothos, Spider Plants, Mint, and Peace Lilies!`;
  }
  
  if (q.includes("emergency") || q.includes("shutdown") || q.includes("stop")) {
    return lastData.emergency == 1
      ? "The System is currently under EMERGENCY SHUTDOWN. All irrigation pump mechanisms are disabled for safety. Click 'Resume System' to re-enable normal loops."
      : "You can trigger an Emergency Shutdown at any time using the console button. This immediately cuts off power to the water pump in case of hardware leaks or stalls.";
  }
  
  if (q.includes("soil") || q.includes("dry") || q.includes("water") || q.includes("moisture")) {
    if (lastData.water < 20) {
      return `Hydration Alert: Groundwater moisture is ${lastData.soil}%. Reservoir tank capacity is extremely low at ${lastData.water}%. Refill the tank immediately!`;
    }
    return `Hydration Status: Groundwater moisture is ${lastData.soil}% (${lastData.soilStatus}). Reservoir level is at ${lastData.water}%. Automation routines are fully operational.`;
  }
  
  if (q.includes("temperature") || q.includes("temp") || q.includes("humidity") || q.includes("climate")) {
    return `Climate Audit: Temperature currently reads ${lastData.temperature}°C, and relative humidity is ${lastData.humidity}%. Vitals are within normal atmospheric bounds.`;
  }

  if (q.includes("ir") || q.includes("proximity") || q.includes("touch") || q.includes("sensor")) {
    return `Sensor Bus: Capacitive touch is currently ${lastData.touch == 1 ? 'TRIGGERED' : 'OPEN'} and Proximity IR scanner reads ${lastData.ir == 1 ? 'DETECTION ACTIVE' : 'CLEAR'}.`;
  }
  
  return "Query processed by Biosphera AI Core. I can diagnose soil moisture parameters, water level safety, climate thresholds, emergency overrides, or recommend suitable houseplants based on current vitals. Ask me anything!";
}
