#include <WiFi.h>
#include <WebServer.h>

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>

// ---------------- WIFI ACCESS POINT ----------------
const char* apName = "Smart_Plant_ESP32";
const char* apPassword = "12345678";

WebServer server(80);

// ---------------- PINS ----------------
#define SOIL_PIN 34
#define RELAY_PIN 23

#define TRIG_PIN 18
#define ECHO_PIN 19

#define BUZZER_PIN 26

#define DHT_PIN 4
#define DHT_TYPE DHT11

#define TOUCH_PIN 27
#define IR_PIN 32

#define OLED_SDA 21
#define OLED_SCL 22

// ---------------- RELAY LOGIC ----------------
// Relay is controlled through BC548 transistor
#define RELAY_ON HIGH
#define RELAY_OFF LOW

// Change these if touch or IR logic is opposite
#define TOUCH_ACTIVE HIGH
#define IR_DETECTED LOW

// ---------------- OLED ----------------
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);
DHT dht(DHT_PIN, DHT_TYPE);

// ---------------- SOIL CALIBRATION ----------------
int dryValue = 4095;
int wetValue = 1352;

int dryThreshold = 35;
int wetThreshold = 60;

// ---------------- WATER TANK CALIBRATION ----------------
float emptyDistance = 11.52;
float fullDistance = 4.25;

int lowWaterThreshold = 20;

// ---------------- TIMING ----------------
unsigned long pumpRunTime = 3000;
unsigned long waitAfterWatering = 10000;

unsigned long lastDHTRead = 0;
unsigned long dhtInterval = 2000;

unsigned long lastScreenSwitch = 0;
unsigned long screenInterval = 5000;

int screenPage = 0;

// ---------------- TOUCH LATCH ----------------
bool lastTouchState = false;
unsigned long happyFaceStart = 0;
unsigned long happyFaceDuration = 3000;

// ---------------- NON-BLOCKING PUMP CONTROL ----------------
bool pumpRunning = false;
bool wateringCooldown = false;

unsigned long pumpStartedAt = 0;
unsigned long cooldownStartedAt = 0;

// ---------------- EMERGENCY STOP ----------------
bool emergencyStop = false;

// ---------------- VALUES ----------------
int moisturePercent = 0;
int waterLevelPercent = 0;

float temperature = 0;
float humidity = 0;

String soilStatus = "OK";
String pumpStatus = "OFF";
String tankStatus = "OK";

// ---------------- FUNCTION DECLARATIONS ----------------
void showEmergencyScreen();
void handleRoot();
void handleAPIData();
void handleBuzzTest();
void handleEmergencyToggle();

// ---------------- ULTRASONIC FUNCTION ----------------
float getDistance() {
  long duration;

  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);

  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);

  digitalWrite(TRIG_PIN, LOW);

  duration = pulseIn(ECHO_PIN, HIGH, 30000);

  if (duration == 0) {
    return -1;
  }

  float distance = duration * 0.0343 / 2;
  return distance;
}

// ---------------- BUZZER FUNCTIONS ----------------
void lowWaterBeep() {
  tone(BUZZER_PIN, 1000);
  delay(200);
  server.handleClient();

  noTone(BUZZER_PIN);
  delay(200);
  server.handleClient();
}

void playBuzzerOnce() {
  tone(BUZZER_PIN, 1000);
  delay(300);
  server.handleClient();

  noTone(BUZZER_PIN);
  delay(150);
  server.handleClient();

  tone(BUZZER_PIN, 1500);
  delay(300);
  server.handleClient();

  noTone(BUZZER_PIN);
  delay(150);
  server.handleClient();

  tone(BUZZER_PIN, 2000);
  delay(300);
  server.handleClient();

  noTone(BUZZER_PIN);
}

// ---------------- WEB SERVER FUNCTIONS ----------------
void handleRoot() {
  server.sendHeader("Access-Control-Allow-Origin", "*");

  server.send(200, "text/html",
              "<h1>Smart Plant ESP32</h1>"
              "<p>ESP32 API is running.</p>"
              "<p>/api/data = live sensor data</p>"
              "<p>/api/buzz = buzzer test</p>"
              "<p>/api/emergency-toggle = emergency shutdown/resume</p>");
}

void handleAPIData() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");

  // Raw sensor values
  int touchRaw = digitalRead(TOUCH_PIN);
  int irRaw = digitalRead(IR_PIN);

  // Converted values for website
  // 0 = inactive, 1 = active
  int touchStatus = (touchRaw == TOUCH_ACTIVE) ? 1 : 0;
  int irStatus = (irRaw == IR_DETECTED) ? 1 : 0;

  String json = "{";
  json += "\"soil\":" + String(moisturePercent) + ",";
  json += "\"soilStatus\":\"" + soilStatus + "\",";
  json += "\"pump\":\"" + pumpStatus + "\",";
  json += "\"water\":" + String(waterLevelPercent) + ",";
  json += "\"tankStatus\":\"" + tankStatus + "\",";
  json += "\"temperature\":" + String(temperature, 1) + ",";
  json += "\"humidity\":" + String(humidity, 1) + ",";
  json += "\"touch\":" + String(touchStatus) + ",";
  json += "\"ir\":" + String(irStatus) + ",";
  json += "\"emergency\":";
  json += emergencyStop ? "true" : "false";
  json += "}";

  server.send(200, "application/json", json);
}

void handleBuzzTest() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");

  playBuzzerOnce();

  server.send(200, "application/json",
              "{\"success\":true,\"message\":\"Buzzer tested\"}");
}

void handleEmergencyToggle() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");

  emergencyStop = !emergencyStop;

  digitalWrite(RELAY_PIN, RELAY_OFF);
  noTone(BUZZER_PIN);

  pumpRunning = false;
  wateringCooldown = false;
  pumpStatus = "OFF";

  if (emergencyStop) {
    showEmergencyScreen();

    server.send(200, "application/json",
                "{\"success\":true,\"emergency\":true,\"message\":\"Emergency shutdown activated\"}");
  } else {
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);

    display.setCursor(0, 10);
    display.println("System Resumed");

    display.setCursor(0, 30);
    display.println("Auto mode active");

    display.display();

    server.send(200, "application/json",
                "{\"success\":true,\"emergency\":false,\"message\":\"System resumed\"}");
  }
}

// ---------------- DISPLAY FUNCTIONS ----------------
void showPlantScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.println("Plant Monitor");

  display.setCursor(0, 16);
  display.print("Soil: ");
  display.print(moisturePercent);
  display.println("%");

  display.setCursor(0, 31);
  display.print("Status: ");
  display.println(soilStatus);

  display.setCursor(0, 46);
  display.print("Pump: ");
  display.println(pumpStatus);

  display.display();
}

void showTankScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.println("Water Tank");

  display.setCursor(0, 18);
  display.print("Water: ");
  display.print(waterLevelPercent);
  display.println("%");

  display.setCursor(0, 36);
  display.print("Tank: ");
  display.println(tankStatus);

  display.setCursor(0, 52);
  if (waterLevelPercent < lowWaterThreshold) {
    display.println("Alert: Refill!");
  } else {
    display.println("Alert: Safe");
  }

  display.display();
}

void showRoomScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 0);
  display.println("Room Monitor");

  display.setCursor(0, 20);
  display.print("Temp: ");
  display.print(temperature);
  display.println(" C");

  display.setCursor(0, 40);
  display.print("Humidity: ");
  display.print(humidity);
  display.println("%");

  display.display();
}

void showLowWaterWarning() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(10, 10);
  display.println("LOW WATER!");

  display.setCursor(0, 30);
  display.println("Refill tank");

  display.setCursor(0, 48);
  display.println("Pump stopped");

  display.display();
}

void showEmergencyScreen() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 8);
  display.println("EMERGENCY STOP");

  display.setCursor(0, 28);
  display.println("Pump disabled");

  display.setCursor(0, 46);
  display.println("Click again reset");

  display.display();
}

void showNormalEyes() {
  display.clearDisplay();

  display.fillRoundRect(24, 18, 30, 30, 8, SSD1306_WHITE);
  display.fillRoundRect(74, 18, 30, 30, 8, SSD1306_WHITE);

  display.fillCircle(39, 33, 5, SSD1306_BLACK);
  display.fillCircle(89, 33, 5, SSD1306_BLACK);

  display.display();
}

void showBlinkEyes() {
  display.clearDisplay();

  display.fillRoundRect(24, 32, 30, 4, 2, SSD1306_WHITE);
  display.fillRoundRect(74, 32, 30, 4, 2, SSD1306_WHITE);

  display.display();
}

void showHappyEyes() {
  display.clearDisplay();

  display.drawLine(24, 36, 36, 26, SSD1306_WHITE);
  display.drawLine(36, 26, 54, 36, SSD1306_WHITE);

  display.drawLine(74, 36, 86, 26, SSD1306_WHITE);
  display.drawLine(86, 26, 104, 36, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(44, 52);
  display.println("Happy!");

  display.display();
}

void showSurprisedEyes() {
  display.clearDisplay();

  display.drawCircle(39, 32, 16, SSD1306_WHITE);
  display.drawCircle(89, 32, 16, SSD1306_WHITE);

  display.fillCircle(39, 32, 6, SSD1306_WHITE);
  display.fillCircle(89, 32, 6, SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(30, 54);
  display.println("Someone near!");

  display.display();
}

void normalEyeAnimation() {
  showNormalEyes();
  delay(600);
  server.handleClient();

  showBlinkEyes();
  delay(180);
  server.handleClient();

  showNormalEyes();
  delay(600);
  server.handleClient();
}

// ---------------- SENSOR READ FUNCTIONS ----------------
void readSoil() {
  int soilValue = analogRead(SOIL_PIN);

  moisturePercent = map(soilValue, dryValue, wetValue, 0, 100);
  moisturePercent = constrain(moisturePercent, 0, 100);

  if (moisturePercent < dryThreshold) {
    soilStatus = "DRY";
  } else if (moisturePercent > wetThreshold) {
    soilStatus = "WET";
  } else {
    soilStatus = "OK";
  }
}

void readWaterLevel() {
  float distanceCm = getDistance();

  if (distanceCm == -1) {
    waterLevelPercent = 0;
    tankStatus = "ERROR";
    return;
  }

  waterLevelPercent = ((emptyDistance - distanceCm) / (emptyDistance - fullDistance)) * 100;
  waterLevelPercent = constrain(waterLevelPercent, 0, 100);

  if (waterLevelPercent < lowWaterThreshold) {
    tankStatus = "LOW";
  } else if (waterLevelPercent > 80) {
    tankStatus = "FULL";
  } else {
    tankStatus = "OK";
  }
}

void readDHTSensor() {
  if (millis() - lastDHTRead >= dhtInterval) {
    lastDHTRead = millis();

    float h = dht.readHumidity();
    float t = dht.readTemperature();

    if (!isnan(h) && !isnan(t)) {
      humidity = h;
      temperature = t;
    }
  }
}

// ---------------- NON-BLOCKING WATERING FUNCTION ----------------
void handleWatering() {
  // Emergency mode blocks pump and buzzer
  if (emergencyStop) {
    digitalWrite(RELAY_PIN, RELAY_OFF);
    noTone(BUZZER_PIN);

    pumpRunning = false;
    wateringCooldown = false;
    pumpStatus = "OFF";

    showEmergencyScreen();
    return;
  }

  // If tank water is low, never run the pump
  if (waterLevelPercent < lowWaterThreshold) {
    digitalWrite(RELAY_PIN, RELAY_OFF);

    pumpRunning = false;
    wateringCooldown = false;
    pumpStatus = "OFF";

    if (moisturePercent < dryThreshold) {
      showLowWaterWarning();
      lowWaterBeep();
    }

    return;
  }

  // If pump is running, keep it ON until runtime finishes
  if (pumpRunning) {
    digitalWrite(RELAY_PIN, RELAY_ON);
    pumpStatus = "ON";

    if (millis() - pumpStartedAt >= pumpRunTime) {
      digitalWrite(RELAY_PIN, RELAY_OFF);

      pumpRunning = false;
      wateringCooldown = true;
      cooldownStartedAt = millis();

      pumpStatus = "WAIT";
    }

    return;
  }

  // Cooldown after watering
  if (wateringCooldown) {
    digitalWrite(RELAY_PIN, RELAY_OFF);
    pumpStatus = "WAIT";

    if (millis() - cooldownStartedAt >= waitAfterWatering) {
      wateringCooldown = false;
      pumpStatus = "OFF";
    }

    return;
  }

  // Start watering if soil is dry
  if (moisturePercent < dryThreshold) {
    pumpRunning = true;
    pumpStartedAt = millis();

    digitalWrite(RELAY_PIN, RELAY_ON);
    pumpStatus = "ON";

    return;
  }

  // Normal state
  digitalWrite(RELAY_PIN, RELAY_OFF);
  pumpStatus = "OFF";
}

// ---------------- DISPLAY CONTROL ----------------
void handleDisplay() {
  if (emergencyStop) {
    showEmergencyScreen();
    delay(500);
    server.handleClient();
    return;
  }

  int touchValue = digitalRead(TOUCH_PIN);
  int irValue = digitalRead(IR_PIN);

  bool isTouched = (touchValue == TOUCH_ACTIVE);
  bool personNear = (irValue == IR_DETECTED);

  // Detect first touch moment
  if (isTouched && !lastTouchState) {
    happyFaceStart = millis();
  }

  lastTouchState = isTouched;

  // Happy face stays after one touch
  if (happyFaceStart > 0 && millis() - happyFaceStart < happyFaceDuration) {
    showHappyEyes();
    delay(300);
    server.handleClient();
    return;
  }

  // IR reaction
  if (personNear) {
    showSurprisedEyes();
    delay(1000);
    server.handleClient();
    return;
  }

  // Change screen every 5 seconds
  if (millis() - lastScreenSwitch >= screenInterval) {
    screenPage++;

    if (screenPage > 3) {
      screenPage = 0;
    }

    lastScreenSwitch = millis();
  }

  if (screenPage == 0) {
    showPlantScreen();
  } else if (screenPage == 1) {
    showTankScreen();

    if (waterLevelPercent < lowWaterThreshold) {
      lowWaterBeep();
    }
  } else if (screenPage == 2) {
    showRoomScreen();
  } else if (screenPage == 3) {
    normalEyeAnimation();
  }

  delay(500);
  server.handleClient();
}

// ---------------- SETUP ----------------
void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_OFF);

  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);

  pinMode(BUZZER_PIN, OUTPUT);
  noTone(BUZZER_PIN);

  pinMode(TOUCH_PIN, INPUT);
  pinMode(IR_PIN, INPUT);

  dht.begin();

  Wire.begin(OLED_SDA, OLED_SCL);

  if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println("OLED not found");
    while (true);
  }

  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  display.setCursor(0, 8);
  display.println("Smart Plant System");
  display.setCursor(0, 25);
  display.println("WiFi AP Mode");
  display.setCursor(0, 42);
  display.println("Starting...");
  display.display();

  delay(2000);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName, apPassword);

  Serial.println("ESP32 Access Point Started");
  Serial.print("Wi-Fi Name: ");
  Serial.println(apName);
  Serial.print("Password: ");
  Serial.println(apPassword);
  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.softAPIP());

  server.on("/", handleRoot);
  server.on("/api/data", handleAPIData);
  server.on("/api/buzz", handleBuzzTest);
  server.on("/api/emergency-toggle", handleEmergencyToggle);

  server.begin();

  Serial.println("Web API server started.");

  display.clearDisplay();
  display.setCursor(0, 0);
  display.println("WiFi Started");
  display.setCursor(0, 18);
  display.println("Smart_Plant_ESP32");
  display.setCursor(0, 36);
  display.println("IP: 192.168.4.1");
  display.display();

  delay(3000);

  lastScreenSwitch = millis();

  Serial.println("Final Smart Plant Monitoring System with Web API Started");
}

// ---------------- LOOP ----------------
void loop() {
  server.handleClient();

  readSoil();
  readWaterLevel();
  readDHTSensor();

  handleWatering();

  server.handleClient();

  // Raw values for debugging
  int touchRaw = digitalRead(TOUCH_PIN);
  int irRaw = digitalRead(IR_PIN);

  int touchStatus = (touchRaw == TOUCH_ACTIVE) ? 1 : 0;
  int irStatus = (irRaw == IR_DETECTED) ? 1 : 0;

  Serial.print("Soil: ");
  Serial.print(moisturePercent);
  Serial.print("% | ");

  Serial.print("Water: ");
  Serial.print(waterLevelPercent);
  Serial.print("% | ");

  Serial.print("Temp: ");
  Serial.print(temperature);
  Serial.print(" C | ");

  Serial.print("Humidity: ");
  Serial.print(humidity);
  Serial.print("% | ");

  Serial.print("Pump: ");
  Serial.print(pumpStatus);
  Serial.print(" | ");

  Serial.print("Tank: ");
  Serial.print(tankStatus);
  Serial.print(" | ");

  Serial.print("Emergency: ");
  Serial.print(emergencyStop ? "ON" : "OFF");
  Serial.print(" | ");

  Serial.print("Touch: ");
  Serial.print(touchStatus);
  Serial.print(" | ");

  Serial.print("IR Proximity: ");
  Serial.println(irStatus);

  handleDisplay();

  server.handleClient();
}