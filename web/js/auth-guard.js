import {
  auth, db, ref, onValue, get,
  FIREBASE_CONFIGURED, localUser
} from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { importCompletedSessionsForCurrentUser } from "./local-history.js";
import { ensureInitialUserState, getCurrentDevice } from "./user-state.js";

// ── Auth guard ────────────────────────────────────
export function requireAuth() {
  if (!FIREBASE_CONFIGURED) return Promise.resolve(localUser);

  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, async user => {
      unsub();
      if (user) {
        try {
          await ensureInitialUserState(user);
        } catch (error) {
          console.warn("[Auth] Initial user state could not be synchronized:", error?.code || error?.message || error);
        }
        importCompletedSessionsForCurrentUser(user);
        resolve(user);
      }
      else { window.location.href = "login.html"; reject("not-authenticated"); }
    });
  });
}

// ================================================================
// TRANSLATIONS — dipusatkan di sini supaya semua halaman bisa pakai
// ================================================================
export const LANG = {
  en: {
    settingsTitle:"Settings", settingsSub:"Manage your preferences — synced across all devices",
    pricingTitle:"💰 Energy Pricing", currencyLabel:"Currency",
    tariffLabel:"Tariff per kWh", thresholdLabel:"Overload Threshold (Watt)",
    thresholdSub:"Alert when device power exceeds this value",
    savePricing:"Save Pricing & Threshold",
    accountTitle:"👤 Account", nameLabel:"Display Name", emailLabel:"Email",
    saveProfile:"Update Profile",
    appearanceTitle:"🎨 Appearance", themeLabel:"Theme",
    themeDark:"Dark", themeDarker:"Darker", themeLight:"Light",
    langLabel:"Language", saveAppearance:"Save Appearance",
    notifTitle:"🔔 Notifications & Dashboard",
    notifDevice:"Device connected notification",
    notifDeviceSub:"Show toast when device is plugged in",
    notifDisconnect:"Device disconnected notification",
    notifDisconnectSub:"Show toast when device is unplugged",
    notifSession:"Session saved notification",
    notifSessionSub:"Show toast when session is saved",
    notifOverload:"Overload notification",
    notifOverloadSub:"Show alert when power exceeds threshold",
    refreshLabel:"Dashboard refresh interval", saveNotif:"Save Preferences",
    dataTitle:"📊 Data Control",
    dataSub:"History and settings are synced to your account across all devices.",
    exportAll:"↓ Export All History CSV", deleteAll:"✕ Delete All History",
    aboutTitle:"ℹ About", aboutApp:"Application", aboutVer:"Version",
    aboutHw:"Hardware", aboutCloud:"Cloud",
    // Sidebar & nav
    navDashboard:"Dashboard", navHistory:"History", navDevice:"Device", navMembers:"Members", navSettings:"Settings",
    signOut:"Sign Out",
    // Dashboard page strings
    dashTitle:"Dashboard", noActiveDevice:"No active device",
    stopSession:"⏹ Stop Session",
    addDeviceTitle:"Add Device",
    addDeviceSub:"Give your device a name to start monitoring",
    deviceNameLabel:"Device Name",
    deviceNamePlaceholder:"e.g. Laptop, AC, Charger",
    cancelBtn:"Cancel", startMonitoring:"Start Monitoring",
    // Stat labels
    labelEnergy:"Energy", labelCost:"Estimated Cost",
    labelSessionCount:"Session Count", labelDeviceName:"Device Name",
    allDevices:"All devices total",
    advReadings:"Advanced Readings", forTech:"For technical reference",
    labelPF:"Power Factor", pfDesc:"0 = poor · 1 = ideal",
    labelFreq:"Frequency", freqDesc:"Hz · standard: 50 Hz",
    labelApparent:"Apparent Power", apparentDesc:"VA · V × I",
    // History page
    histTitle:"History", exportAllCSV:"↓ Export All CSV", deleteAll2:"✕ Delete All",
    searchPlaceholder:"Search by device name...",
    noSessions:"No sessions found",
    noSessionsSub:"Start monitoring a device from the Dashboard",
    allDevicesTab:"All Devices",
    // Advanced page
    advTitle:"Advanced Readings", advSub:"Technical data for engineers & enthusiasts",
    advHeroTitle:"⚠ Technical Reference",
    advHeroSub:"Data on this page is intended for technical analysis. Power Factor and Frequency readings require an active device to be meaningful.",
    clearLog:"✕ Clear Log", exportLog:"↓ Export CSV",
    waitingData:"Waiting for live data...",
  },
  id: {
    settingsTitle:"Pengaturan", settingsSub:"Kelola preferensi kamu — tersinkron di semua perangkat",
    pricingTitle:"💰 Harga Energi", currencyLabel:"Mata Uang",
    tariffLabel:"Tarif per kWh", thresholdLabel:"Batas Overload (Watt)",
    thresholdSub:"Kirim peringatan saat daya melebihi nilai ini",
    savePricing:"Simpan Tarif & Threshold",
    accountTitle:"👤 Akun", nameLabel:"Nama Tampilan", emailLabel:"Email",
    saveProfile:"Perbarui Profil",
    appearanceTitle:"🎨 Tampilan", themeLabel:"Tema",
    themeDark:"Gelap", themeDarker:"Lebih Gelap", themeLight:"Terang",
    langLabel:"Bahasa", saveAppearance:"Simpan Tampilan",
    notifTitle:"🔔 Notifikasi & Dashboard",
    notifDevice:"Notifikasi device terhubung",
    notifDeviceSub:"Tampilkan notifikasi saat device dicolok",
    notifDisconnect:"Notifikasi device dicabut",
    notifDisconnectSub:"Tampilkan notifikasi saat device dicabut",
    notifSession:"Notifikasi sesi tersimpan",
    notifSessionSub:"Tampilkan notifikasi saat sesi disimpan",
    notifOverload:"Notifikasi overload",
    notifOverloadSub:"Tampilkan peringatan saat daya melebihi batas",
    refreshLabel:"Interval refresh dashboard", saveNotif:"Simpan Preferensi",
    dataTitle:"📊 Kontrol Data",
    dataSub:"Riwayat dan pengaturan tersinkron ke akun kamu di semua perangkat.",
    exportAll:"↓ Ekspor Semua Riwayat CSV", deleteAll:"✕ Hapus Semua Riwayat",
    aboutTitle:"ℹ Tentang", aboutApp:"Aplikasi", aboutVer:"Versi",
    aboutHw:"Perangkat Keras", aboutCloud:"Cloud",
    // Sidebar & nav
    navDashboard:"Dasbor", navHistory:"Riwayat", navDevice:"Device", navMembers:"Anggota", navSettings:"Pengaturan",
    signOut:"Keluar",
    // Dashboard page strings
    dashTitle:"Dasbor", noActiveDevice:"Tidak ada device aktif",
    stopSession:"⏹ Hentikan Sesi",
    addDeviceTitle:"Tambah Device",
    addDeviceSub:"Berikan nama untuk device yang terhubung",
    deviceNameLabel:"Nama Device",
    deviceNamePlaceholder:"mis. Laptop, AC, Charger",
    cancelBtn:"Batal", startMonitoring:"Mulai Monitoring",
    // Stat labels
    labelEnergy:"Energi", labelCost:"Estimasi Biaya",
    labelSessionCount:"Jumlah Sesi", labelDeviceName:"Nama Device",
    allDevices:"Total semua device",
    advReadings:"Pembacaan Lanjutan", forTech:"Untuk referensi teknis",
    labelPF:"Faktor Daya", pfDesc:"0 = buruk · 1 = ideal",
    labelFreq:"Frekuensi", freqDesc:"Hz · standar: 50 Hz",
    labelApparent:"Daya Semu", apparentDesc:"VA · V × I",
    // History page
    histTitle:"Riwayat", exportAllCSV:"↓ Ekspor Semua CSV", deleteAll2:"✕ Hapus Semua",
    searchPlaceholder:"Cari nama device...",
    noSessions:"Tidak ada sesi ditemukan",
    noSessionsSub:"Mulai monitoring device dari Dasbor",
    allDevicesTab:"Semua Device",
    // Advanced page
    advTitle:"Pembacaan Lanjutan", advSub:"Data teknis untuk insinyur & penggemar",
    advHeroTitle:"⚠ Referensi Teknis",
    advHeroSub:"Data di halaman ini ditujukan untuk analisis teknis. Pembacaan Power Factor dan Frekuensi memerlukan device aktif.",
    clearLog:"✕ Hapus Log", exportLog:"↓ Ekspor CSV",
    waitingData:"Menunggu data langsung...",
  }
};

Object.assign(LANG.en, {
  loading: "Loading...",
  saving: "Saving...",
  commonDelete: "Delete",
  commonUnknown: "Unknown",
  paired: "Paired",
  pairingPending: "Pairing pending",
  statusUnavailable: "Status unavailable",
  notReported: "Not reported",
  deviceAccessUnavailable: "Device access unavailable",
  noDevicePairedYet: "No device paired yet",
  pairDeviceToMonitor: "Pair your VOLTIX device to start monitoring.",
  dashboardEyebrow: "Smart energy command center",
  dashboardLiveTitle: "Live Energy Dashboard",
  dashboardHeroInitial: "Ready to monitor when ESP32 is online.",
  dashboardActiveDevice: "Active device",
  dashboardConnection: "Connection",
  dashboardSession: "Session",
  dashboardRelay: "Relay",
  dashboardMode: "Mode",
  dashboardWaiting: "Waiting",
  dashboardTransition: "Transition",
  dashboardCommandNote: "Uses the existing START/STOP command flow.",
  dashboardStart: "Start Monitoring",
  dashboardStop: "Stop Session",
  dashboardStartTitle: "Start a new monitoring session",
  dashboardStopTitle: "Stop monitoring and save the session",
  dashboardStarting: "Starting...",
  dashboardSaving: "Saving...",
  dashboardMonitoringActive: "Monitoring Active",
  dashboardStartWaitingTitle: "Start command sent. Waiting for ESP32 confirmation.",
  dashboardStopSavingTitle: "Stop is saving the current session.",
  dashboardEspOnlineRequiredTitle: "ESP32 must be online before starting.",
  dashboardReady: "Ready to monitor",
  dashboardWaitingLoad: "Waiting for load",
  dashboardMonitoring: "Monitoring active",
  dashboardStopping: "Stopping and saving session",
  dashboardSaved: "Session saved",
  dashboardOffline: "Device offline",
  dashboardOverload: "Overload protection active",
  dashboardSessionIdleHelp: "Ready for live readings.",
  dashboardSessionStartingHelp: "START sent. Waiting for load confirmation.",
  dashboardSessionMonitoringHelp: "Collecting live power and energy data.",
  dashboardSessionStoppingHelp: "Saving the final session report.",
  dashboardSessionFinishedHelp: "Session saved. History will refresh shortly.",
  dashboardSessionOfflineHelp: "ESP32 internet is offline.",
  dashboardSessionOverloadHelp: "Power exceeded the configured threshold.",
  dashboardRelayOnHelp: "Relay is energized by ESP32.",
  dashboardRelayOffHelp: "Relay is off and safe.",
  dashboardModeOnlineHelp: "Cloud telemetry is active.",
  dashboardModeOfflineHelp: "ESP32 is keeping local safety state.",
  dashboardModeTransitionHelp: "State transition in progress.",
  dashboardLinkFresh: "Fresh live data received.",
  dashboardLinkWaitingFresh: "ESP32 internet is online; waiting for fresh telemetry.",
  dashboardLinkLastKnown: "Using last known ESP32 update.",
  dashboardLinkWaitingFirst: "Waiting for first live packet.",
  dashboardNoDeviceTitle: "No device paired yet",
  dashboardNoDeviceSub: "Pair your VOLTIX device to unlock live monitoring.",
  dashboardLiveUnavailable: "Device live data unavailable",
  dashboardOpenDevice: "Open Device Page",
  dashboardCurrentSession: "Current session",
  dashboardEnergySummary: "Energy Summary",
  dashboardTechnicalSnapshot: "Technical snapshot",
  dashboardAdvancedCopy: "Quick power-quality indicators from the connected VOLTIX device.",
  dashboardOpenAdvanced: "Open Advanced View",
  dashboardLiveDemand: "Live demand",
  dashboardPower: "Power",
  dashboardAcInput: "AC input",
  dashboardLoadDraw: "Load draw",
  dashboardVoltage: "Voltage",
  dashboardCurrent: "Current",
  dashboardDuration: "Duration",
  dashboardDurationValue: "Duration: {duration}",
  dashboardDeviceReportedElapsed: "Device-reported elapsed time",
  dashboardSessionsUnit: "sessions",
  dashboardSavedHistoryTotal: "Saved history total",
  dashboardWebWaitingEsp: "Web: waiting for ESP32...",
  dashboardWebOnline: "Web: online",
  dashboardWebOnlineWaiting: "Web: online (waiting for fresh data)",
  dashboardWebOfflineSeconds: "Web: offline ({seconds}s)",
  dashboardWebOfflineMinutes: "Web: offline ({minutes}m)",
  dashboardTariff: "Tariff: {symbol} {tariff}/kWh",
  dashboardConnected: "Connected",
  dashboardLive: "Live",
  dashboardNoLoad: "No Load",
  dashboardOfflineModeBanner: "Mode: OFFLINE - Relay: ON",
  dashboardPendingSync: "{count} Pending Sync",
  dashboardRelayReady: "Tap + to start a new monitoring session",
  dashboardOfflineSessionTitle: "ESP32 is measuring in offline mode",
  dashboardOfflineSessionSub: "Data will appear when ESP32 reconnects to the internet",
  dashboardOfflineSessionNamed: "{device} (Offline Mode)",
  dashboardOfflineSessionLocal: "Relay ON - data is saved locally - will sync when online",
  dashboardOverloadBanner: "OVERLOAD - Power is above {threshold}W. Relay was turned off automatically.",
  dashboardManualModalTitle: "Add Device (Online Mode)",
  dashboardManualModalSub: "Name the device, then click Start Monitoring to turn the relay on.",
  dashboardAutoModalTitle: "Device Detected!",
  dashboardAutoModalSub: "Give the newly connected device a name.",
  dashboardNameTooLong: "Maximum 24 characters",
  dashboardTurnRelayOn: "Turning relay on for \"{name}\"...",
  dashboardStartOnlineOnly: "ESP32 is not connected. You can only start in Online Mode.",
  dashboardStartAlreadyPending: "Start command is already waiting for ESP32 confirmation",
  dashboardAlreadyMonitoring: "\"{name}\" is already being monitored",
  dashboardNoSession: "No session is running",
  dashboardStopToast: "Stopping and saving session...",
  dashboardLoadNotDetected: "Monitoring \"{name}\" canceled: load was not detected",
  dashboardDeviceDetected: "Device detected! Give it a name.",
  dashboardDeviceNameReminder: "Device has been connected for {seconds}s. Please name it.",
  dashboardSessionSavedSynced: "Session \"{name}\" saved and synced to History",
  dashboardSessionEndedEsp: "Session \"{name}\" finished on ESP32",
  dashboardDeviceUnpluggedBeforeName: "Device was unplugged before it was named",
  dashboardDeviceUnpluggedWaitHistory: "Device \"{name}\" unplugged - waiting for ESP32 history",
  dashboardEspOnlineSynced: "ESP32 online - offline data synced: {energy} kWh",
  dashboardEspOnlineMode: "ESP32 online - Mode: {mode}",
  dashboardOverloadToast: "OVERLOAD! {power}W >= {threshold}W",
  dashboardMonitoringStarted: "Monitoring \"{name}\" started",
  dashboardMonitoringStartedRetro: "Monitoring \"{name}\" started ({minutes} min counted)",
  dashboardMonitoringLabel: "Monitoring: {name}",
  dashboardLiveTelemetryLabel: "Live telemetry: {name}",
  historyEyebrow: "Energy archive",
  historyTitle: "Session History",
  historyCountInitial: "0 sessions recorded",
  historyUsageOverview: "Usage Overview",
  historyPortfolioTotals: "Portfolio totals",
  historyOverviewSub: "Combined metrics from all loaded VOLTIX sessions.",
  historyTotalSessions: "Total Sessions",
  historyCompletedRecords: "Completed records",
  historyTotalDuration: "Total Duration",
  historyTotalEnergy: "Total Energy",
  historyAccumulatedConsumption: "Accumulated consumption",
  historyTotalCost: "Total Cost",
  historyEstimatedSpend: "Estimated spend",
  historyAveragePower: "Average Power",
  historyAcrossSessions: "Across all sessions",
  historySessionBrowser: "Session browser",
  historyCompletedSessions: "Completed Sessions",
  historyBrowserSub: "Search, filter, sort, export, or inspect a completed report.",
  historyExportAll: "Export All CSV",
  historyDeleteAll: "Delete All",
  historyDeleteNote: "Deletes cloud history and requests ESP32 local cleanup.",
  historyResetFilters: "Reset Filters",
  historyClearFiltersTitle: "Clear all history filters",
  historySearchPlaceholder: "Search by device name...",
  historyFilterDevice: "Device",
  historyFilterMode: "Mode",
  historyFilterStatus: "Status / End Reason",
  historyFilterDate: "Date Range",
  historySortBy: "Sort By",
  historyAllDevices: "All Devices",
  historyAllModes: "All Modes",
  historyAllStatuses: "All Statuses",
  historyAllTime: "All Time",
  historyToday: "Today",
  historyLast7: "Last 7 Days",
  historyLast30: "Last 30 Days",
  historyNewest: "Newest",
  historyOldest: "Oldest",
  historyHighestEnergy: "Highest Energy",
  historyHighestCost: "Highest Cost",
  historyLongestDuration: "Longest Duration",
  historyLoadingCount: "Loading sessions...",
  historyLoadingTitle: "Loading history...",
  historyLoadingSub: "Fetching cloud history and device completed sessions.",
  historyCount: "{shown} of {total} {label}",
  historySessionSingular: "session",
  historySessionPlural: "sessions",
  historyAccessDenied: "Access denied for this device history",
  historyNoDevicePaired: "No device paired",
  historyNoSessionsYet: "No sessions yet",
  historyNoSessionsFound: "No sessions found",
  historyEmptySub: "No sessions yet. Start monitoring from Dashboard.",
  historyAdjustFilters: "Adjust the filters or start monitoring from Dashboard.",
  historyCompletedSession: "Completed session",
  historyPower: "Power",
  historyEnergy: "Energy",
  historyCost: "Cost",
  historySynced: "Synced",
  historyPending: "Pending",
  historySyncUnknown: "Sync Unknown",
  historyStopByApp: "Stop by App",
  historyDeviceRemoved: "Device Removed",
  historyPowerLoss: "Power Loss",
  historyOfflineMonitoring: "Offline Monitoring",
  historyCompleted: "Completed",
  historyOnlineToOffline: "Online to Offline",
  historyOfflineToOnline: "Offline to Online",
  historyExportCsvTitle: "Export CSV",
  historyExportCsvAria: "Export session CSV",
  historyDeleteSessionTitle: "Delete session",
  historyDeleteSessionConfirm: "Delete this session?",
  historyDeleteAllConfirm: "Delete all history? Cloud data will be deleted and ESP32 will be asked to clean local history.",
  historyCloudDeletedNoCleanup: "Cloud history deleted. Device cleanup request unavailable.",
  historyCloudDeletedCleanupPending: "Cloud history deleted. Device cleanup pending",
  historyDeviceCleanupPending: "Device cleanup pending",
  historyDeviceLocalCleared: "Device local history cleared",
  historyResolveSourceFail: "Unable to resolve history source",
  historyResolveDeviceFail: "Unable to resolve device history",
  historyDeleteDenied: "Delete denied by Firebase rules",
  historyCleanupRequestFailed: "Cloud history deleted. Device cleanup request failed.",
  historyDeleteFailed: "Failed to delete",
  historyNoExportData: "No data to export",
  historyNothingDelete: "Nothing to delete",
  historyExported: "Exported successfully",
  historyExportedSession: "Exported {name}",
  membersEyebrow: "Access control",
  membersTitle: "Member Management",
  membersSub: "Owner, operator, and viewer support will be added later.",
  membersComingSoon: "Coming Soon",
  membersComingSoonTitle: "Member Management Coming Soon",
  membersComingSoonSub: "Owner/operator/viewer controls will be added later.",
  membersPlaceholderSub: "VOLTIX will support owner, operator, and viewer roles in a future release. This page is a visual placeholder only and does not change account sharing, device access, Firebase paths, or member rules.",
  membersBackDashboard: "Back to Dashboard",
  membersFullControl: "Full Control",
  membersOwnerDesc: "Device management and member invitations.",
  membersOperate: "Operate",
  membersOperatorDesc: "Start, stop, and monitor assigned devices.",
  membersReadOnly: "Read Only",
  membersViewerDesc: "View live status and history reports.",
  deviceTitle: "Device",
  deviceSub: "Pair and view your current VOLTIX device.",
  devicePairTitle: "Pair your VOLTIX device",
  devicePairPrompt: "Enter the 6-digit code shown on the OLED display.",
  devicePairSub: "Stage A claims work only when the documented development pairing rules are active.",
  devicePairingCode: "Pairing code",
  devicePairButton: "Pair Device",
  devicePairing: "Pairing...",
  deviceCurrentTitle: "Current Device",
  deviceName: "Name",
  deviceId: "Device ID",
  deviceRole: "Role",
  deviceFirmware: "Firmware",
  deviceStatus: "Status",
  deviceFoundationNote: "Device actions and pairing management remain intentionally unavailable in this foundation sprint.",
  deviceOpenDashboard: "Open Dashboard",
  deviceCodeInvalid: "Enter the 6-digit code shown on the device.",
  devicePairingUnavailable: "Pairing is unavailable in local visual mode.",
  devicePairedSuccess: "Device \"{name}\" paired successfully",
  devicePairingFailed: "Pairing failed.",
  deviceStateLoadFailed: "Device state could not be loaded.",
  detailTitle: "Session Detail",
  detailExported: "Detail exported",
  settingsValidTariff: "Enter a valid tariff value",
  settingsValidThreshold: "Enter a valid threshold value",
  settingsSaved: "Settings saved",
  settingsSaveFailed: "Failed to save settings - check your internet connection",
  settingsNameRequired: "Name cannot be empty",
  settingsProfileUpdated: "Profile updated",
  settingsProfileFailed: "Failed to update profile",
  settingsAppearanceUpdated: "Appearance updated",
  settingsAppearanceFailed: "Failed to save appearance",
  settingsPreferencesSaved: "Preferences saved",
  settingsPreferencesFailed: "Failed to save preferences",
  settingsExportNoData: "No history data to export",
  settingsExportSuccess: "History exported",
  settingsDeleteConfirm: "Delete all history? This removes your account history in the cloud.",
  settingsDeleteSuccess: "History deleted",
  settingsDeleteFailed: "Failed to delete history"
});

Object.assign(LANG.en, {
  detailBack: "Back to History",
  detailReportEyebrow: "Completed session report",
  detailLoading: "Loading selected session...",
  detailExport: "Export Detail CSV",
  detailEmptyTitle: "No selected session",
  detailEmptySub: "Return to History and choose a monitoring session.",
  detailOpenHistory: "Open History",
  detailSessionReport: "Session report",
  detailCorePerformance: "Core performance",
  detailMainSummary: "Main Session Summary",
  detailPowerQuality: "Power quality",
  detailReadings: "Electrical Readings",
  detailTraceability: "Traceability",
  detailMetadata: "Session Metadata",
  detailForecast: "Forecast",
  detailProjection: "Usage Projection",
  detailModeUnknown: "Mode Unknown",
  detailEnergyTotal: "Energy Total",
  detailCostTotal: "Cost Total",
  detailMaxPower: "Max Power",
  detailVoltageAverage: "Voltage Average",
  detailVoltageRange: "Voltage Min / Max",
  detailCurrentAverage: "Current Average",
  detailCurrentMax: "Current Max",
  detailPowerAverage: "Power Average",
  detailPowerMax: "Power Max",
  detailPowerFactorAverage: "Power Factor Average",
  detailFrequencyAverage: "Frequency Average",
  detailApparentPowerAverage: "Apparent Power Average",
  detailOverloadThreshold: "Overload Threshold",
  detailSessionId: "Session ID",
  detailOwnerUid: "Owner UID",
  detailStartTime: "Start Time",
  detailEndTime: "End Time",
  detailStartMode: "Start Mode",
  detailEndMode: "End Mode",
  detailEndReason: "End Reason",
  detailOverloadStatus: "Overload Status",
  detailOverloadDetected: "Overload detected",
  detailNoOverload: "No overload",
  detailRelayFinal: "Relay Final State",
  detailSyncStatus: "Sync Status",
  detailPendingSync: "Pending Sync",
  detailCreatedFrom: "Created From",
  detailSyncedAt: "Synced At",
  detailProjectionUnavailable: "Average power is unavailable, so usage projections cannot be calculated.",
  detailProjectionIntro: "Estimated usage for {name} based on {power} W average power.",
  detailHour: "{count} hour",
  detailHours: "{count} hours",
  yes: "Yes",
  no: "No"
});

Object.assign(LANG.en, {
  advLive: "LIVE",
  advPfDescLong: "Ratio of active power (W) to apparent power (VA). Closer to 1.0 means more efficient. Most home appliances: 0.7-0.95.",
  advFreqLabel: "Grid Frequency",
  advFreqStandard: "Standard: 50 Hz (Indonesia PLN)",
  advFreqDescLong: "AC grid frequency from PLN. Normal range: 49.5-50.5 Hz. Deviation may indicate grid instability or heavy load conditions.",
  advApparentDescLong: "Total power drawn from the grid (V x I). Includes both active and reactive power. Always >= active power (W).",
  advReactiveLabel: "Reactive Power",
  advReactiveDescLong: "Calculated from apparent and active power. This is power that oscillates between source and load without doing useful work.",
  advFormulaTitle: "Live Calculation Reference",
  advPowerOverTime: "Power Factor over time",
  advFreqOverTime: "Frequency over time",
  advPowerCompare: "Active vs Apparent Power",
  advReactiveOverTime: "Reactive Power over time",
  advTime: "Time",
  advWaitingData: "Waiting for live data..."
});

Object.assign(LANG.en, {
  shellNavigation: "Navigation",
  shellLogoSub: "Smart Energy Monitor",
  dashboardAnalytics: "Analytics",
  dashboardEnergyIntelligence: "Energy Intelligence",
  dashboardRealtime: "Realtime",
  dashboardPowerOverTime: "Power Over Time",
  dashboardHistoryKicker: "History",
  dashboardDeviceUsage: "Device Usage",
  dashboardShare: "Share",
  dashboardEnergyDistribution: "Energy Distribution",
  dashboardLiveTelemetry: "Live telemetry",
  dashboardRelayIdle: "Relay is idle.",
  dashboardWaitingEspState: "Waiting for ESP32 state.",
  dashboardListeningLiveData: "Listening for live data.",
  dashboardLow: "LOW",
  dashboardNominal: "NOMINAL",
  dashboardHigh: "HIGH",
  dashboardIdleShort: "IDLE",
  dashboardActiveShort: "ACTIVE",
  dashboardLimitShort: "LIMIT",
  advPoor: "Poor",
  advIdeal: "Ideal",
  advWaitingDataDot: "Waiting for data",
  advNoDevice: "No Device",
  advExcellent: "Excellent",
  advGood: "Good",
  advFair: "Fair",
  advNormal: "Normal",
  advAcceptable: "Acceptable",
  advOutOfRange: "Out of range",
  advDeviation: "deviation",
  advPowerCard: "Power",
  advActivePower: "Active Power (W)",
  advApparentPower: "Apparent Power (VA)",
  advReactivePower: "Reactive Power (VAR)",
  advEnergyCost: "Energy & Cost",
  advSessionEnergyWh: "Session Energy (Wh)",
  advSessionEnergyKwh: "Session Energy (kWh)",
  advEstimatedCost: "Estimated Cost",
  advTariffUsed: "Tariff used",
  advVoltage: "V (V)",
  advCurrent: "I (A)",
  advPActive: "P Active (W)",
  advSApparent: "S Apparent (VA)",
  advQReactive: "Q Reactive (VAR)",
  advExportCsv: "Export CSV",
  detailCompletedReport: "Completed session report",
  detailSessionReportName: "Device"
});

Object.assign(LANG.id, {
  loading: "Memuat...",
  saving: "Menyimpan...",
  commonDelete: "Hapus",
  commonUnknown: "Tidak diketahui",
  paired: "Terpasang",
  pairingPending: "Menunggu pairing",
  statusUnavailable: "Status tidak tersedia",
  notReported: "Belum dilaporkan",
  deviceAccessUnavailable: "Akses device tidak tersedia",
  noDevicePairedYet: "Belum ada device terpasang",
  pairDeviceToMonitor: "Pasangkan device VOLTIX untuk mulai monitoring.",
  dashboardEyebrow: "Pusat kendali energi pintar",
  dashboardLiveTitle: "Dasbor Energi Real-time",
  dashboardHeroInitial: "Siap monitoring saat ESP32 online.",
  dashboardActiveDevice: "Device aktif",
  dashboardConnection: "Koneksi",
  dashboardSession: "Sesi",
  dashboardRelay: "Relay",
  dashboardMode: "Mode",
  dashboardWaiting: "Menunggu",
  dashboardTransition: "Transisi",
  dashboardCommandNote: "Menggunakan alur command START/STOP yang sudah ada.",
  dashboardStart: "Mulai Monitoring",
  dashboardStop: "Hentikan Sesi",
  dashboardStartTitle: "Mulai sesi monitoring baru",
  dashboardStopTitle: "Hentikan monitoring dan simpan sesi",
  dashboardStarting: "Memulai...",
  dashboardSaving: "Menyimpan...",
  dashboardMonitoringActive: "Monitoring Aktif",
  dashboardStartWaitingTitle: "Command START terkirim. Menunggu konfirmasi ESP32.",
  dashboardStopSavingTitle: "STOP sedang menyimpan sesi saat ini.",
  dashboardEspOnlineRequiredTitle: "ESP32 harus online sebelum mulai.",
  dashboardReady: "Siap memulai monitoring",
  dashboardWaitingLoad: "Menunggu beban terdeteksi",
  dashboardMonitoring: "Monitoring aktif",
  dashboardStopping: "Menghentikan dan menyimpan sesi",
  dashboardSaved: "Sesi tersimpan",
  dashboardOffline: "Device offline",
  dashboardOverload: "Proteksi overload aktif",
  dashboardSessionIdleHelp: "Siap untuk pembacaan langsung.",
  dashboardSessionStartingHelp: "START terkirim. Menunggu konfirmasi beban.",
  dashboardSessionMonitoringHelp: "Mengumpulkan data daya dan energi langsung.",
  dashboardSessionStoppingHelp: "Menyimpan laporan akhir sesi.",
  dashboardSessionFinishedHelp: "Sesi tersimpan. Riwayat akan segera diperbarui.",
  dashboardSessionOfflineHelp: "Internet ESP32 sedang offline.",
  dashboardSessionOverloadHelp: "Daya melewati batas yang dikonfigurasi.",
  dashboardRelayOnHelp: "Relay sedang aktif dari ESP32.",
  dashboardRelayOffHelp: "Relay mati dan aman.",
  dashboardModeOnlineHelp: "Telemetri cloud sedang aktif.",
  dashboardModeOfflineHelp: "ESP32 menjaga status lokal.",
  dashboardModeTransitionHelp: "Transisi status sedang berlangsung.",
  dashboardLinkFresh: "Data langsung terbaru diterima.",
  dashboardLinkWaitingFresh: "Internet ESP32 online; menunggu telemetri terbaru.",
  dashboardLinkLastKnown: "Menggunakan update ESP32 terakhir.",
  dashboardLinkWaitingFirst: "Menunggu paket data langsung pertama.",
  dashboardNoDeviceTitle: "Belum ada device terpasang",
  dashboardNoDeviceSub: "Pasangkan device VOLTIX untuk membuka monitoring langsung.",
  dashboardLiveUnavailable: "Data langsung device tidak tersedia",
  dashboardOpenDevice: "Buka Halaman Device",
  dashboardCurrentSession: "Sesi saat ini",
  dashboardEnergySummary: "Ringkasan Energi",
  dashboardTechnicalSnapshot: "Snapshot teknis",
  dashboardAdvancedCopy: "Indikator kualitas daya cepat dari device VOLTIX yang terhubung.",
  dashboardOpenAdvanced: "Buka Tampilan Lanjutan",
  dashboardLiveDemand: "Beban langsung",
  dashboardPower: "Daya",
  dashboardAcInput: "Input AC",
  dashboardLoadDraw: "Tarikan beban",
  dashboardVoltage: "Tegangan",
  dashboardCurrent: "Arus",
  dashboardDuration: "Durasi",
  dashboardDurationValue: "Durasi: {duration}",
  dashboardDeviceReportedElapsed: "Durasi yang dilaporkan device",
  dashboardSessionsUnit: "sesi",
  dashboardSavedHistoryTotal: "Total riwayat tersimpan",
  dashboardWebWaitingEsp: "Web: menunggu ESP32...",
  dashboardWebOnline: "Web: online",
  dashboardWebOnlineWaiting: "Web: online (menunggu data terbaru)",
  dashboardWebOfflineSeconds: "Web: offline ({seconds}d)",
  dashboardWebOfflineMinutes: "Web: offline ({minutes}m)",
  dashboardTariff: "Tarif: {symbol} {tariff}/kWh",
  dashboardConnected: "Terhubung",
  dashboardLive: "Langsung",
  dashboardNoLoad: "Tanpa Beban",
  dashboardOfflineModeBanner: "Mode: OFFLINE - Relay: ON",
  dashboardPendingSync: "{count} Pending Sync",
  dashboardRelayReady: "Ketuk + untuk memulai sesi pengukuran baru",
  dashboardOfflineSessionTitle: "ESP32 mengukur dalam mode offline",
  dashboardOfflineSessionSub: "Data akan tampil saat ESP32 kembali terhubung ke internet",
  dashboardOfflineSessionNamed: "{device} (Mode Offline)",
  dashboardOfflineSessionLocal: "Relay ON - data disimpan lokal - akan sinkron saat online",
  dashboardOverloadBanner: "OVERLOAD - Daya melebihi {threshold}W. Relay dimatikan otomatis.",
  dashboardManualModalTitle: "Tambah Device (Mode Online)",
  dashboardManualModalSub: "Beri nama device, lalu klik Mulai Monitoring untuk menyalakan relay.",
  dashboardAutoModalTitle: "Device Terdeteksi!",
  dashboardAutoModalSub: "Berikan nama untuk device yang baru terhubung.",
  dashboardNameTooLong: "Maksimal 24 karakter",
  dashboardTurnRelayOn: "Menyalakan relay untuk \"{name}\"...",
  dashboardStartOnlineOnly: "ESP32 tidak terhubung. Monitoring hanya bisa dimulai dalam Mode Online.",
  dashboardStartAlreadyPending: "Command START sedang menunggu konfirmasi ESP32",
  dashboardAlreadyMonitoring: "\"{name}\" sedang dimonitor",
  dashboardNoSession: "Tidak ada sesi yang berjalan",
  dashboardStopToast: "Menghentikan dan menyimpan sesi...",
  dashboardLoadNotDetected: "Monitoring \"{name}\" dibatalkan: beban tidak terdeteksi",
  dashboardDeviceDetected: "Device terdeteksi! Berikan nama.",
  dashboardDeviceNameReminder: "Device sudah {seconds}d terhubung. Segera beri nama.",
  dashboardSessionSavedSynced: "Sesi \"{name}\" tersimpan dan tersinkron ke Riwayat",
  dashboardSessionEndedEsp: "Sesi \"{name}\" selesai di ESP32",
  dashboardDeviceUnpluggedBeforeName: "Device dicabut sebelum diberi nama",
  dashboardDeviceUnpluggedWaitHistory: "Device \"{name}\" dicabut - menunggu riwayat ESP32",
  dashboardEspOnlineSynced: "ESP32 online - data offline tersinkron: {energy} kWh",
  dashboardEspOnlineMode: "ESP32 online - Mode: {mode}",
  dashboardOverloadToast: "OVERLOAD! {power}W >= {threshold}W",
  dashboardMonitoringStarted: "Monitoring \"{name}\" dimulai",
  dashboardMonitoringStartedRetro: "Monitoring \"{name}\" dimulai ({minutes} menit terhitung)",
  dashboardMonitoringLabel: "Monitoring: {name}",
  dashboardLiveTelemetryLabel: "Telemetri langsung: {name}",
  historyEyebrow: "Arsip energi",
  historyTitle: "Riwayat Sesi",
  historyCountInitial: "0 sesi tersimpan",
  historyUsageOverview: "Ringkasan Pemakaian",
  historyPortfolioTotals: "Total portofolio",
  historyOverviewSub: "Gabungan metrik dari semua sesi VOLTIX yang dimuat.",
  historyTotalSessions: "Total Sesi",
  historyCompletedRecords: "Catatan selesai",
  historyTotalDuration: "Total Durasi",
  historyTotalEnergy: "Total Energi",
  historyAccumulatedConsumption: "Akumulasi konsumsi",
  historyTotalCost: "Total Biaya",
  historyEstimatedSpend: "Estimasi pengeluaran",
  historyAveragePower: "Daya Rata-rata",
  historyAcrossSessions: "Di semua sesi",
  historySessionBrowser: "Pencari sesi",
  historyCompletedSessions: "Sesi Selesai",
  historyBrowserSub: "Cari, filter, urutkan, ekspor, atau periksa laporan selesai.",
  historyExportAll: "Ekspor Semua CSV",
  historyDeleteAll: "Hapus Semua",
  historyDeleteNote: "Menghapus riwayat cloud dan meminta ESP32 membersihkan riwayat lokal.",
  historyResetFilters: "Reset Filter",
  historyClearFiltersTitle: "Hapus semua filter riwayat",
  historySearchPlaceholder: "Cari nama device...",
  historyFilterDevice: "Device",
  historyFilterMode: "Mode",
  historyFilterStatus: "Status / Alasan Selesai",
  historyFilterDate: "Rentang Tanggal",
  historySortBy: "Urutkan",
  historyAllDevices: "Semua Device",
  historyAllModes: "Semua Mode",
  historyAllStatuses: "Semua Status",
  historyAllTime: "Semua Waktu",
  historyToday: "Hari Ini",
  historyLast7: "7 Hari Terakhir",
  historyLast30: "30 Hari Terakhir",
  historyNewest: "Terbaru",
  historyOldest: "Terlama",
  historyHighestEnergy: "Energi Tertinggi",
  historyHighestCost: "Biaya Tertinggi",
  historyLongestDuration: "Durasi Terlama",
  historyLoadingCount: "Memuat sesi...",
  historyLoadingTitle: "Memuat riwayat...",
  historyLoadingSub: "Mengambil riwayat cloud dan sesi selesai dari device.",
  historyCount: "{shown} dari {total} {label}",
  historySessionSingular: "sesi",
  historySessionPlural: "sesi",
  historyAccessDenied: "Akses riwayat device ini ditolak",
  historyNoDevicePaired: "Belum ada device terpasang",
  historyNoSessionsYet: "Belum ada sesi",
  historyNoSessionsFound: "Tidak ada sesi ditemukan",
  historyEmptySub: "Belum ada sesi. Mulai monitoring dari Dasbor.",
  historyAdjustFilters: "Sesuaikan filter atau mulai monitoring dari Dasbor.",
  historyCompletedSession: "Sesi selesai",
  historyPower: "Daya",
  historyEnergy: "Energi",
  historyCost: "Biaya",
  historySynced: "Tersinkron",
  historyPending: "Tertunda",
  historySyncUnknown: "Status sinkron tidak diketahui",
  historyStopByApp: "Dihentikan dari App",
  historyDeviceRemoved: "Device Dicabut",
  historyPowerLoss: "Listrik Terputus",
  historyOfflineMonitoring: "Monitoring Offline",
  historyCompleted: "Selesai",
  historyOnlineToOffline: "Online ke Offline",
  historyOfflineToOnline: "Offline ke Online",
  historyExportCsvTitle: "Ekspor CSV",
  historyExportCsvAria: "Ekspor CSV sesi",
  historyDeleteSessionTitle: "Hapus sesi",
  historyDeleteSessionConfirm: "Hapus sesi ini?",
  historyDeleteAllConfirm: "Hapus semua riwayat? Data cloud akan dihapus dan ESP32 akan diminta membersihkan riwayat lokal.",
  historyCloudDeletedNoCleanup: "Riwayat cloud dihapus. Request cleanup device tidak tersedia.",
  historyCloudDeletedCleanupPending: "Riwayat cloud dihapus. Cleanup device menunggu",
  historyDeviceCleanupPending: "Cleanup device menunggu",
  historyDeviceLocalCleared: "Riwayat lokal device dibersihkan",
  historyResolveSourceFail: "Sumber riwayat tidak dapat ditentukan",
  historyResolveDeviceFail: "Riwayat device tidak dapat ditentukan",
  historyDeleteDenied: "Penghapusan ditolak oleh Firebase rules",
  historyCleanupRequestFailed: "Riwayat cloud dihapus. Request cleanup device gagal.",
  historyDeleteFailed: "Gagal menghapus",
  historyNoExportData: "Tidak ada data untuk diekspor",
  historyNothingDelete: "Tidak ada yang bisa dihapus",
  historyExported: "Berhasil diekspor",
  historyExportedSession: "{name} diekspor",
  membersEyebrow: "Kontrol akses",
  membersTitle: "Manajemen Anggota",
  membersSub: "Dukungan owner, operator, dan viewer akan ditambahkan nanti.",
  membersComingSoon: "Segera Hadir",
  membersComingSoonTitle: "Manajemen Anggota Segera Hadir",
  membersComingSoonSub: "Kontrol owner/operator/viewer akan ditambahkan nanti.",
  membersPlaceholderSub: "VOLTIX akan mendukung peran owner, operator, dan viewer di rilis mendatang. Halaman ini hanya placeholder visual dan tidak mengubah berbagi akun, akses device, path Firebase, atau rules anggota.",
  membersBackDashboard: "Kembali ke Dasbor",
  membersFullControl: "Kontrol Penuh",
  membersOwnerDesc: "Manajemen device dan undangan anggota.",
  membersOperate: "Operasikan",
  membersOperatorDesc: "Mulai, hentikan, dan monitor device yang ditugaskan.",
  membersReadOnly: "Hanya Baca",
  membersViewerDesc: "Melihat status langsung dan laporan riwayat.",
  deviceTitle: "Device",
  deviceSub: "Pasangkan dan lihat device VOLTIX saat ini.",
  devicePairTitle: "Pasangkan device VOLTIX",
  devicePairPrompt: "Masukkan kode 6 digit yang tampil di OLED.",
  devicePairSub: "Claim Tahap A hanya berjalan saat rules pairing development yang terdokumentasi aktif.",
  devicePairingCode: "Kode pairing",
  devicePairButton: "Pasangkan Device",
  devicePairing: "Memasangkan...",
  deviceCurrentTitle: "Device Saat Ini",
  deviceName: "Nama",
  deviceId: "Device ID",
  deviceRole: "Peran",
  deviceFirmware: "Firmware",
  deviceStatus: "Status",
  deviceFoundationNote: "Aksi device dan manajemen pairing sengaja belum tersedia di sprint fondasi ini.",
  deviceOpenDashboard: "Buka Dasbor",
  deviceCodeInvalid: "Masukkan kode 6 digit yang tampil di device.",
  devicePairingUnavailable: "Pairing tidak tersedia dalam mode visual lokal.",
  devicePairedSuccess: "Device \"{name}\" berhasil dipasangkan",
  devicePairingFailed: "Pairing gagal.",
  deviceStateLoadFailed: "Status device tidak dapat dimuat.",
  detailTitle: "Detail Sesi",
  detailExported: "Detail diekspor",
  settingsValidTariff: "Masukkan nilai tarif yang valid",
  settingsValidThreshold: "Masukkan nilai threshold yang valid",
  settingsSaved: "Pengaturan tersimpan",
  settingsSaveFailed: "Gagal menyimpan pengaturan - cek koneksi internet",
  settingsNameRequired: "Nama tidak boleh kosong",
  settingsProfileUpdated: "Profil diperbarui",
  settingsProfileFailed: "Gagal memperbarui profil",
  settingsAppearanceUpdated: "Tampilan diperbarui",
  settingsAppearanceFailed: "Gagal menyimpan tampilan",
  settingsPreferencesSaved: "Preferensi tersimpan",
  settingsPreferencesFailed: "Gagal menyimpan preferensi",
  settingsExportNoData: "Tidak ada riwayat untuk diekspor",
  settingsExportSuccess: "Riwayat diekspor",
  settingsDeleteConfirm: "Hapus semua riwayat? Ini menghapus riwayat akun kamu di cloud.",
  settingsDeleteSuccess: "Riwayat dihapus",
  settingsDeleteFailed: "Gagal menghapus riwayat"
});

Object.assign(LANG.id, {
  detailBack: "Kembali ke Riwayat",
  detailReportEyebrow: "Laporan sesi selesai",
  detailLoading: "Memuat sesi terpilih...",
  detailExport: "Ekspor Detail CSV",
  detailEmptyTitle: "Belum ada sesi dipilih",
  detailEmptySub: "Kembali ke Riwayat dan pilih sesi monitoring.",
  detailOpenHistory: "Buka Riwayat",
  detailSessionReport: "Laporan sesi",
  detailCorePerformance: "Performa inti",
  detailMainSummary: "Ringkasan Utama Sesi",
  detailPowerQuality: "Kualitas daya",
  detailReadings: "Pembacaan Listrik",
  detailTraceability: "Keterlacakan",
  detailMetadata: "Metadata Sesi",
  detailForecast: "Proyeksi",
  detailProjection: "Proyeksi Pemakaian",
  detailModeUnknown: "Mode tidak diketahui",
  detailEnergyTotal: "Total Energi",
  detailCostTotal: "Total Biaya",
  detailMaxPower: "Daya Maks",
  detailVoltageAverage: "Tegangan Rata-rata",
  detailVoltageRange: "Tegangan Min / Maks",
  detailCurrentAverage: "Arus Rata-rata",
  detailCurrentMax: "Arus Maks",
  detailPowerAverage: "Daya Rata-rata",
  detailPowerMax: "Daya Maks",
  detailPowerFactorAverage: "Faktor Daya Rata-rata",
  detailFrequencyAverage: "Frekuensi Rata-rata",
  detailApparentPowerAverage: "Daya Semu Rata-rata",
  detailOverloadThreshold: "Batas Overload",
  detailSessionId: "Session ID",
  detailOwnerUid: "Owner UID",
  detailStartTime: "Waktu Mulai",
  detailEndTime: "Waktu Selesai",
  detailStartMode: "Mode Mulai",
  detailEndMode: "Mode Selesai",
  detailEndReason: "Alasan Selesai",
  detailOverloadStatus: "Status Overload",
  detailOverloadDetected: "Overload terdeteksi",
  detailNoOverload: "Tidak ada overload",
  detailRelayFinal: "Status Akhir Relay",
  detailSyncStatus: "Status Sinkron",
  detailPendingSync: "Pending Sync",
  detailCreatedFrom: "Dibuat Dari",
  detailSyncedAt: "Tersinkron Pada",
  detailProjectionUnavailable: "Daya rata-rata tidak tersedia, jadi proyeksi pemakaian tidak dapat dihitung.",
  detailProjectionIntro: "Estimasi pemakaian untuk {name} berdasarkan daya rata-rata {power} W.",
  detailHour: "{count} jam",
  detailHours: "{count} jam",
  yes: "Ya",
  no: "Tidak"
});

Object.assign(LANG.id, {
  advLive: "LANGSUNG",
  advPfDescLong: "Rasio daya aktif (W) terhadap daya semu (VA). Semakin dekat ke 1,0 berarti semakin efisien. Umumnya alat rumah: 0,7-0,95.",
  advFreqLabel: "Frekuensi Grid",
  advFreqStandard: "Standar: 50 Hz (PLN Indonesia)",
  advFreqDescLong: "Frekuensi listrik AC dari PLN. Rentang normal: 49,5-50,5 Hz. Deviasi dapat menandakan instabilitas grid atau beban berat.",
  advApparentDescLong: "Total daya yang ditarik dari grid (V x I). Mencakup daya aktif dan reaktif. Selalu >= daya aktif (W).",
  advReactiveLabel: "Daya Reaktif",
  advReactiveDescLong: "Dihitung dari daya semu dan daya aktif. Ini adalah daya yang berosilasi antara sumber dan beban tanpa menghasilkan kerja berguna.",
  advFormulaTitle: "Referensi Perhitungan Langsung",
  advPowerOverTime: "Faktor Daya sepanjang waktu",
  advFreqOverTime: "Frekuensi sepanjang waktu",
  advPowerCompare: "Daya Aktif vs Daya Semu",
  advReactiveOverTime: "Daya Reaktif sepanjang waktu",
  advTime: "Waktu",
  advWaitingData: "Menunggu data langsung..."
});

Object.assign(LANG.id, {
  shellNavigation: "Navigasi",
  shellLogoSub: "Monitor Energi Pintar",
  dashboardAnalytics: "Analitik",
  dashboardEnergyIntelligence: "Intelijen Energi",
  dashboardRealtime: "Real-time",
  dashboardPowerOverTime: "Daya Sepanjang Waktu",
  dashboardHistoryKicker: "Riwayat",
  dashboardDeviceUsage: "Pemakaian Device",
  dashboardShare: "Distribusi",
  dashboardEnergyDistribution: "Distribusi Energi",
  dashboardLiveTelemetry: "Telemetri langsung",
  dashboardRelayIdle: "Relay sedang idle.",
  dashboardWaitingEspState: "Menunggu status ESP32.",
  dashboardListeningLiveData: "Mendengarkan data langsung.",
  dashboardLow: "RENDAH",
  dashboardNominal: "NOMINAL",
  dashboardHigh: "TINGGI",
  dashboardIdleShort: "IDLE",
  dashboardActiveShort: "AKTIF",
  dashboardLimitShort: "BATAS",
  advPoor: "Buruk",
  advIdeal: "Ideal",
  advWaitingDataDot: "Menunggu data",
  advNoDevice: "Tidak Ada Device",
  advExcellent: "Sangat Baik",
  advGood: "Baik",
  advFair: "Cukup",
  advNormal: "Normal",
  advAcceptable: "Dapat diterima",
  advOutOfRange: "Di luar rentang",
  advDeviation: "deviasi",
  advPowerCard: "Daya",
  advActivePower: "Daya Aktif (W)",
  advApparentPower: "Daya Semu (VA)",
  advReactivePower: "Daya Reaktif (VAR)",
  advEnergyCost: "Energi & Biaya",
  advSessionEnergyWh: "Energi Sesi (Wh)",
  advSessionEnergyKwh: "Energi Sesi (kWh)",
  advEstimatedCost: "Estimasi Biaya",
  advTariffUsed: "Tarif dipakai",
  advVoltage: "V (V)",
  advCurrent: "I (A)",
  advPActive: "P Aktif (W)",
  advSApparent: "S Semu (VA)",
  advQReactive: "Q Reaktif (VAR)",
  advExportCsv: "Ekspor CSV",
  detailCompletedReport: "Laporan sesi selesai",
  detailSessionReportName: "Device"
});

let currentLanguage = "en";

export function getCurrentLanguage() {
  return currentLanguage;
}

export function t(key, fallback = "", replacements = {}) {
  const hasKey = LANG[currentLanguage]?.[key] !== undefined || LANG.en?.[key] !== undefined;
  if (!hasKey) return fallback || key;
  return tr(key, replacements);
}

export function tr(key, replacements = {}) {
  const template = LANG[currentLanguage]?.[key] ?? LANG.en?.[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) =>
    replacements[name] !== undefined ? String(replacements[name]) : `{${name}}`
  );
}

// ── Utility: set text ─────────────────────────────
function s(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function attr(id, name, val) { const el = document.getElementById(id); if (el) el.setAttribute(name, val); }
function optionText(selector, val) { const el = document.querySelector(selector); if (el) el.textContent = val; }

function applyDataI18n() {
  document.querySelectorAll("[data-i18n]").forEach(el => {
    el.textContent = t(el.dataset.i18n, el.textContent);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder, el.getAttribute("placeholder") || "");
  });
  document.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle, el.getAttribute("title") || "");
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach(el => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel, el.getAttribute("aria-label") || ""));
  });
}

// ================================================================
// applyLanguage — apply ke semua halaman (bukan hanya settings)
// Dipanggil dari renderShell setelah settings di-load
// ================================================================
export function applyLanguage(lang) {
  currentLanguage = LANG[lang] ? lang : "en";
  const t = LANG[currentLanguage] || LANG.en;
  applyDataI18n();
  document.documentElement.lang = currentLanguage;
  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle?.dataset.i18n) {
    document.title = `VOLTIX ${tr(topbarTitle.dataset.i18n)}`;
  }

  // ── Dashboard page ──
  s("page-title-dash",          t.dashTitle);
  s("active-device-label-txt",  t.noActiveDevice);
  s("btn-stop-txt",             t.stopSession);
  s("modal-add-title",          t.addDeviceTitle);
  s("modal-add-sub",            t.addDeviceSub);
  s("modal-device-label",       t.deviceNameLabel);
  s("modal-cancel-txt",         t.cancelBtn);
  s("modal-save-txt",           t.startMonitoring);
  s("stat-label-energy",        t.labelEnergy);
  s("stat-label-cost",          t.labelCost);
  s("stat-label-sessions",      t.labelSessionCount);
  s("stat-label-device",        t.labelDeviceName);
  s("stat-all-devices",         t.allDevices);
  s("adv-readings-title",       t.advReadings);
  s("adv-readings-sub",         t.forTech);
  s("adv-label-pf",             t.labelPF);
  s("adv-desc-pf",              t.pfDesc);
  s("adv-label-freq",           t.labelFreq);
  s("adv-desc-freq",            t.freqDesc);
  s("adv-label-apparent",       t.labelApparent);
  s("adv-desc-apparent",        t.apparentDesc);

  // ── History page ──
  s("page-title-history",       t.histTitle);
  s("btn-export-all-txt",       t.exportAllCSV);
  s("btn-delete-all-txt",       t.deleteAll2);
  const searchEl = document.getElementById("search-input");
  if (searchEl) searchEl.placeholder = t.searchPlaceholder;

  // ── Advanced page ──
  s("page-title-advanced",      t.advTitle);
  s("page-sub-advanced",        t.advSub);
  s("adv-hero-title",           t.advHeroTitle);
  s("adv-hero-sub",             t.advHeroSub);
  s("btn-clear-log-txt",        t.clearLog);
  s("btn-export-log-txt",       t.exportLog);
  s("adv-live-label",           t.advLive);
  s("adv-pf-desc-long",         t.advPfDescLong);
  s("adv-freq-label",           t.advFreqLabel);
  s("freq-deviation",           t.advFreqStandard);
  s("adv-freq-desc-long",       t.advFreqDescLong);
  s("adv-apparent-desc-long",   t.advApparentDescLong);
  s("adv-reactive-label",       t.advReactiveLabel);
  s("adv-reactive-desc-long",   t.advReactiveDescLong);
  s("adv-formula-title",        t.advFormulaTitle);
  s("adv-chart-pf-title",       t.advPowerOverTime);
  s("adv-chart-freq-title",     t.advFreqOverTime);
  s("adv-chart-power-title",    t.advPowerCompare);
  s("adv-chart-reactive-title", t.advReactiveOverTime);
  s("adv-log-time",             t.advTime);

  // ── Dashboard polish strings ──
  s("dashboard-eyebrow-main",    t.dashboardEyebrow);
  s("dashboard-live-title",      t.dashboardLiveTitle);
  s("hero-active-device-label",  t.dashboardActiveDevice);
  s("hero-state-text",           t.dashboardHeroInitial);
  s("hero-label-connection",     t.dashboardConnection);
  s("hero-label-session",        t.dashboardSession);
  s("hero-label-relay",          t.dashboardRelay);
  s("hero-label-mode",           t.dashboardMode);
  s("command-panel-note",        t.dashboardCommandNote);
  s("btn-start-inline",          t.dashboardStart);
  s("no-device-title",           t.dashboardNoDeviceTitle);
  s("no-device-sub",             t.dashboardNoDeviceSub);
  s("no-device-link",            t.dashboardOpenDevice);
  s("dashboard-current-session", t.dashboardCurrentSession);
  s("dashboard-energy-summary",  t.dashboardEnergySummary);
  s("dashboard-technical-snapshot", t.dashboardTechnicalSnapshot);
  s("dashboard-advanced-copy",   t.dashboardAdvancedCopy);
  s("dashboard-open-advanced",   t.dashboardOpenAdvanced);
  s("dashboard-live-demand",     t.dashboardLiveDemand);
  s("dashboard-power-label",     t.dashboardPower);
  s("dashboard-ac-input",        t.dashboardAcInput);
  s("dashboard-load-draw",       t.dashboardLoadDraw);
  s("dashboard-voltage-label",   t.dashboardVoltage);
  s("dashboard-current-label",   t.dashboardCurrent);
  s("summary-label-energy",      t.labelEnergy);
  s("summary-label-cost",        t.labelCost);
  s("summary-label-duration",    t.dashboardDuration);
  s("summary-label-sessions",    t.labelSessionCount);
  s("summary-label-device",      t.labelDeviceName);
  s("summary-duration-note",     t.dashboardDeviceReportedElapsed);
  s("summary-sessions-unit",     t.dashboardSessionsUnit);
  s("summary-sessions-note",     t.dashboardSavedHistoryTotal);
  s("advanced-preview-title",    t.advReadings);
  s("advanced-preview-pf-label", t.labelPF);
  s("advanced-preview-pf-desc",  t.pfDesc);
  s("advanced-preview-freq-label", t.labelFreq);
  s("advanced-preview-freq-desc", t.freqDesc);
  s("advanced-preview-apparent-label", t.labelApparent);
  s("advanced-preview-apparent-desc", t.apparentDesc);
  attr("btn-stop", "title", t.dashboardStopTitle);
  attr("btn-start-inline", "title", t.dashboardStartTitle);
  attr("btn-start-inline", "aria-label", t.dashboardStartTitle);

  // ── Sidebar nav labels (rendered by renderShell) ──
  s("nav-label-dashboard",      t.navDashboard);
  s("nav-label-history",        t.navHistory);
  s("nav-label-device",         t.navDevice);
  s("nav-label-members",        t.navMembers);
  s("nav-label-settings",       t.navSettings);
  s("sidebar-signout-txt",      t.signOut);

  // ── History page ──
  s("history-eyebrow-main",      t.historyEyebrow);
  s("history-page-title",        t.historyTitle);
  s("history-count",             t.historyCountInitial);
  s("btn-export-all",            t.historyExportAll);
  s("btn-delete-all",            t.historyDeleteAll);
  s("history-danger-note",       t.historyDeleteNote);
  s("history-summary-eyebrow",   t.historyPortfolioTotals);
  s("history-summary-title",     t.historyUsageOverview);
  s("history-summary-sub",       t.historyOverviewSub);
  s("history-summary-sessions-label", t.historyTotalSessions);
  s("history-summary-sessions-note", t.historyCompletedRecords);
  s("history-summary-duration-label", t.historyTotalDuration);
  s("history-summary-duration-note", t.dashboardDeviceReportedElapsed);
  s("history-summary-energy-label", t.historyTotalEnergy);
  s("history-summary-energy-note", t.historyAccumulatedConsumption);
  s("history-summary-cost-label", t.historyTotalCost);
  s("history-summary-cost-note", t.historyEstimatedSpend);
  s("history-summary-power-label", t.historyAveragePower);
  s("history-summary-power-note", t.historyAcrossSessions);
  s("history-browser-eyebrow",   t.historySessionBrowser);
  s("history-browser-title",     t.historyCompletedSessions);
  s("history-browser-sub",       t.historyBrowserSub);
  s("btn-reset-filters",         t.historyResetFilters);
  s("filter-device-label",       t.historyFilterDevice);
  s("filter-mode-label",         t.historyFilterMode);
  s("filter-status-label",       t.historyFilterStatus);
  s("filter-date-label",         t.historyFilterDate);
  s("sort-history-label",        t.historySortBy);
  attr("btn-export-all", "title", t.historyExportAll);
  attr("btn-delete-all", "title", t.historyDeleteNote);
  attr("btn-reset-filters", "title", t.historyClearFiltersTitle);
  if (searchEl) searchEl.placeholder = t.historySearchPlaceholder;
  optionText("#filter-device option[value='all']", t.historyAllDevices);
  optionText("#filter-mode option[value='all']", t.historyAllModes);
  optionText("#filter-mode option[value='online-offline']", t.historyOnlineToOffline);
  optionText("#filter-mode option[value='offline-online']", t.historyOfflineToOnline);
  optionText("#filter-status option[value='all']", t.historyAllStatuses);
  optionText("#filter-status option[value='stop-app']", t.historyStopByApp);
  optionText("#filter-status option[value='device-removed']", t.historyDeviceRemoved);
  optionText("#filter-status option[value='power-loss']", t.historyPowerLoss);
  optionText("#filter-status option[value='offline-monitoring']", t.historyOfflineMonitoring);
  optionText("#filter-date option[value='all']", t.historyAllTime);
  optionText("#filter-date option[value='today']", t.historyToday);
  optionText("#filter-date option[value='7']", t.historyLast7);
  optionText("#filter-date option[value='30']", t.historyLast30);
  optionText("#sort-history option[value='newest']", t.historyNewest);
  optionText("#sort-history option[value='oldest']", t.historyOldest);
  optionText("#sort-history option[value='energy']", t.historyHighestEnergy);
  optionText("#sort-history option[value='cost']", t.historyHighestCost);
  optionText("#sort-history option[value='duration']", t.historyLongestDuration);

  // ── Device page ──
  s("device-page-title",         t.deviceTitle);
  s("device-page-sub",           t.deviceSub);
  s("device-pair-title",         t.devicePairTitle);
  s("device-pair-prompt",        t.devicePairPrompt);
  s("device-pair-sub",           t.devicePairSub);
  s("device-pair-code-label",    t.devicePairingCode);
  s("btn-pair-device",           t.devicePairButton);
  s("device-current-title",      t.deviceCurrentTitle);
  s("device-name-label",         t.deviceName);
  s("device-id-label",           t.deviceId);
  s("device-role-label",         t.deviceRole);
  s("device-firmware-label",     t.deviceFirmware);
  s("device-status-label",       t.deviceStatus);
  s("device-foundation-note",    t.deviceFoundationNote);
  s("device-open-dashboard",     t.deviceOpenDashboard);

  // ── Members page ──
  s("members-eyebrow-main",      t.membersEyebrow);
  s("members-page-title",        t.membersTitle);
  s("members-page-sub",          t.membersSub);
  s("members-coming-soon",       t.membersComingSoon);
  s("placeholder-title",         t.membersComingSoonTitle);
  s("placeholder-sub",           t.membersPlaceholderSub);
  s("members-back-dashboard",    t.membersBackDashboard);
  s("members-owner-title",       t.membersFullControl);
  s("members-owner-desc",        t.membersOwnerDesc);
  s("members-operator-title",    t.membersOperate);
  s("members-operator-desc",     t.membersOperatorDesc);
  s("members-viewer-title",      t.membersReadOnly);
  s("members-viewer-desc",       t.membersViewerDesc);

  // ── History detail page ──
  s("detail-back-link",          t.detailBack);
  s("detail-report-eyebrow",     t.detailReportEyebrow);
  s("detail-device-name",        t.detailTitle);
  s("detail-date",               t.detailLoading);
  s("btn-export",                t.detailExport);
  s("detail-empty-title",        t.detailEmptyTitle);
  s("detail-empty-sub",          t.detailEmptySub);
  s("detail-open-history",       t.detailOpenHistory);
  s("detail-session-report-label", t.detailSessionReport);
  s("detail-core-performance-label", t.detailCorePerformance);
  s("detail-main-summary-label", t.detailMainSummary);
  s("detail-power-quality-label", t.detailPowerQuality);
  s("detail-readings-label",     t.detailReadings);
  s("detail-traceability-label", t.detailTraceability);
  s("detail-metadata-label",     t.detailMetadata);
  s("detail-forecast-label",     t.detailForecast);
  s("detail-projection-label",   t.detailProjection);
}

// ================================================================
// Shell render — sekarang load settings dari Firebase/localStorage
// lalu apply theme + language sebelum render selesai
// ================================================================
export function renderShell(activePage, pageTitle) {
  const sidebarEl = document.getElementById("sidebar");
  const topbarEl  = document.getElementById("topbar");
  const normalizedTitle = String(pageTitle || "").toUpperCase();
  const titleKey = normalizedTitle.includes("SESSION")
    ? "detailTitle"
    : activePage === "dashboard" ? "dashTitle"
      : activePage === "history" ? "histTitle"
      : activePage === "device" ? "deviceTitle"
      : activePage === "members" ? "membersTitle"
      : activePage === "settings" ? "settingsTitle"
      : activePage === "advanced" ? "advTitle"
      : "";
  const navItems  = [
    { href: "index.html",    icon: "⊡", key: "dashboard", labelId: "nav-label-dashboard", defaultLabel: "Dashboard" },
    { href: "history.html",  icon: "◷", key: "history",   labelId: "nav-label-history",   defaultLabel: "History"   },
    { href: "device.html",   icon: "◈", key: "device",    labelId: "nav-label-device",    defaultLabel: "Device"    },
    { href: "members.html",  icon: "◇", key: "members",   labelId: "nav-label-members",   defaultLabel: "Members"   },
    { href: "settings.html", icon: "⚙", key: "settings",  labelId: "nav-label-settings",  defaultLabel: "Settings"  },
  ];

  sidebarEl.innerHTML = `
    <div class="sidebar-logo">
      <div class="sidebar-logo-icon">
        <img src="assets/logo/LOGO.png" alt="VOLTIX Logo" style="width:22px;height:22px;object-fit:contain" onerror="this.style.display='none';this.parentElement.textContent='⚡'"/>
      </div>
      <div>
        <div class="sidebar-logo-text">VOLTIX</div>
        <div class="sidebar-logo-sub" data-i18n="shellLogoSub">Smart Energy Monitor</div>
      </div>
    </div>
    <nav class="sidebar-nav">
      <div class="sidebar-section-label" data-i18n="shellNavigation">Navigation</div>
      ${navItems.map(n => `
        <a href="${n.href}" class="${activePage === n.key ? "active" : ""}">
          <span class="nav-icon">${n.icon}</span>
          <span id="${n.labelId}">${n.defaultLabel}</span>
        </a>`).join("")}
    </nav>
    <div class="sidebar-bottom">
      <div class="sidebar-user" id="sidebar-user">
        <div class="sidebar-user-avatar" id="user-avatar">?</div>
        <div class="sidebar-user-info">
          <div class="sidebar-user-name" id="user-name">Loading...</div>
          <div class="sidebar-user-email" id="user-email"></div>
        </div>
      </div>
      <div style="margin-top:8px;">
        <button id="btn-logout" class="btn btn-ghost" style="width:100%;justify-content:center;font-size:12px;">
          <span id="sidebar-signout-txt">Sign Out</span>
        </button>
      </div>
    </div>`;

  topbarEl.innerHTML = `
    <button class="topbar-menu-btn" id="menu-btn">☰</button>
    <div class="topbar-title" id="topbar-title"${titleKey ? ` data-i18n="${titleKey}"` : ""}>${pageTitle}</div>
    <div class="topbar-status">
      <div class="status-dot" id="system-dot"></div>
      <span id="system-status-text">Connecting...</span>
    </div>`;

  // Sidebar toggle
  const sidebar  = document.getElementById("sidebar");
  const menuBtn  = document.getElementById("menu-btn");
  let backdrop   = document.getElementById("sidebar-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = "sidebar-backdrop";
    backdrop.className = "sidebar-backdrop";
    document.body.appendChild(backdrop);
  }
  const isMobile   = () => window.innerWidth <= 768;
  const openSidebar  = () => { sidebar.classList.add("open"); if (isMobile()) backdrop.classList.add("show"); };
  const closeSidebar = () => { sidebar.classList.remove("open"); backdrop.classList.remove("show"); };
  menuBtn.addEventListener("click", () => sidebar.classList.contains("open") ? closeSidebar() : openSidebar());
  backdrop.addEventListener("click", closeSidebar);
  window.addEventListener("resize", () => { if (!isMobile()) backdrop.classList.remove("show"); });
  if (!isMobile()) openSidebar();

  // Logout
  document.getElementById("btn-logout").addEventListener("click", async () => {
    if (!FIREBASE_CONFIGURED) {
      showToast("Sign out is disabled in local visual mode.");
      return;
    }
    await signOut(auth);
    window.location.href = "login.html";
  });
}

// ================================================================
// loadAndApplySettings — dipanggil oleh setiap halaman setelah
// requireAuth(). Membaca settings dari cache → Firebase, lalu
// apply theme + language ke semua elemen di halaman saat ini.
// ================================================================
export async function loadAndApplySettings(uid) {
  const DEFAULTS = {
    currency: "IDR", tariff: 1444.70, overloadThreshold: 2000,
    overloadWarningPercent: 99, // Default value for overload warning percentage
    // Default values for device-related thresholds and intervals
    // These are typically configured on the device but can be overridden or synced
    loadPowerThreshold: 1,
    loadCurrentThreshold: 0.02,
    loadRemovedDelaySec: 2,
    offlineTimeoutSec: 300,
    checkpointIntervalSec: 30,
    theme: "dark", language: "en",
    notifDevice: true, notifDisconnect: true, notifSession: true,
    notifOverload: true, refreshInterval: 3000
  };

  // 1. Baca dari localStorage dulu (instant, tidak flicker)
  let settings = { ...DEFAULTS };
  try {
    const cached = JSON.parse(localStorage.getItem(`sem_settings_${uid}`)); // Attempt to retrieve cached settings
    // If cached settings exist, merge them with defaults
    // This ensures new default settings are applied if not present in cache
    if (cached) settings = { ...DEFAULTS, ...cached };
  } catch {}

  // Apply segera dari cache supaya tidak flicker
  applyTheme(settings.theme);
  applyLanguage(settings.language);

  // 2. Fetch dari Firebase (sumber kebenaran)
  try {
    const snap = await get(ref(db, `users/${uid}/settings`));
    if (snap.exists()) { // Check if settings exist in Firebase
      const remote = { ...DEFAULTS, ...snap.val() }; // Merge remote settings with defaults
      // Sync to localStorage for immediate access by other pages and devices
      localStorage.setItem(`sem_settings_${uid}`, JSON.stringify(remote)); 
      // Apply theme and language if they have changed from the cached version
      if (remote.theme !== settings.theme) applyTheme(remote.theme);
      if (remote.language !== settings.language) applyLanguage(remote.language);
      settings = remote; // Update current settings to the remote version
    }
  } catch (e) {
    console.warn("[SEM] Gagal load settings dari Firebase:", e);
  }

  try {
    const currentDevice = await getCurrentDevice(uid);
    if (!currentDevice) return settings;
    const appSnap = await get(ref(db, `devices/${currentDevice.id}/config`));
    if (appSnap.exists()) {
      const shared = appSnap.val() || {};
      const sharedThreshold = Number(shared.overloadThreshold ?? shared.threshold);
      const sharedTariff = Number(shared.electricityCostPerKwh ?? shared.tariff ?? shared.tarif);
      const next = { ...settings };
      if (Number.isFinite(sharedThreshold) && sharedThreshold > 0) next.overloadThreshold = sharedThreshold;
      if (Number.isFinite(sharedTariff) && sharedTariff > 0) next.tariff = sharedTariff;
      if (shared.currency) next.currency = shared.currency;
      ["overloadWarningPercent", "loadPowerThreshold", "loadCurrentThreshold",
       "loadRemovedDelaySec", "offlineTimeoutSec", "checkpointIntervalSec"].forEach(key => {
        const value = Number(shared[key]);
        if (Number.isFinite(value) && value > 0) next[key] = value;
      });
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        settings = next;
        localStorage.setItem(`sem_settings_${uid}`, JSON.stringify(settings));
      }
    }
  } catch (e) {
    console.warn("[SEM] Gagal load config global:", e);
  }

  return settings;
}

// ── User info ─────────────────────────────────────
export function fillUserInfo(user) {
  const avatarEl = document.getElementById("user-avatar");
  const nameEl   = document.getElementById("user-name");
  const emailEl  = document.getElementById("user-email");
  if (!avatarEl) return;
  const name = user.displayName || user.email.split("@")[0];
  avatarEl.textContent = name.charAt(0).toUpperCase();
  nameEl.textContent   = name;
  emailEl.textContent  = user.email;
}

// ── Status dot ────────────────────────────────────
export function isEspOnlineStatus(system = {}) {
  const wifiStatus = String(system?.wifiStatus || system?.wifi || system?.status || "").toUpperCase();
  return system?.internet === true || wifiStatus === "CONNECTED" || wifiStatus === "ONLINE";
}

export function setSystemStatus(status) {
  const online = typeof status === "boolean" ? status : isEspOnlineStatus(status);
  const dot  = document.getElementById("system-dot");
  const text = document.getElementById("system-status-text");
  if (!dot) return;
  dot.className    = `status-dot ${online ? "online" : "offline"}`;
  text.textContent = online ? "Online" : "Offline";
}

// ── Firebase status watcher ───────────────────────
export function startStatusWatcher() {
  getCurrentDevice(auth.currentUser?.uid)
    .then(currentDevice => {
      if (!currentDevice) {
        setSystemStatus(false);
        return;
      }
      onValue(ref(db, `devices/${currentDevice.id}/live/system`), snapshot => {
        const sys = snapshot.val() || {};
        setSystemStatus(sys);
      });
    })
    .catch(error => {
      console.warn("[Status] Device status unavailable:", error?.code || error?.message || error);
      setSystemStatus(false);
    });
}

// ── Toast ─────────────────────────────────────────
export function showToast(msg, type = "") {
  let toast = document.getElementById("global-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "global-toast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("show"), 3000);
}

// ── Theme ─────────────────────────────────────────
export function applyTheme(theme) {
  const r = document.documentElement;
  if (theme === "darker") {
    r.style.setProperty("--bg-base",        "#000000");
    r.style.setProperty("--bg-surface",     "#0a0a0a");
    r.style.setProperty("--bg-elevated",    "#111111");
    r.style.setProperty("--bg-hover",       "#181818");
    r.style.setProperty("--text-primary",   "#f0f0f0");
    r.style.setProperty("--text-secondary", "#888888");
    r.style.setProperty("--text-muted",     "#444444");
    r.style.setProperty("--border",         "rgba(255,255,255,0.07)");
    r.style.setProperty("--border-accent",  "rgba(255,255,255,0.15)");
    r.style.setProperty("--chart-tick",     "#555555");
    r.style.setProperty("--chart-grid",     "rgba(255,255,255,0.03)");
  } else if (theme === "light") {
    r.style.setProperty("--bg-base",        "#f0f2f5");
    r.style.setProperty("--bg-surface",     "#ffffff");
    r.style.setProperty("--bg-elevated",    "#f8f9fa");
    r.style.setProperty("--bg-hover",       "#e9ecef");
    r.style.setProperty("--text-primary",   "#1a1a1a");
    r.style.setProperty("--text-secondary", "#555555");
    r.style.setProperty("--text-muted",     "#999999");
    r.style.setProperty("--border",         "rgba(0,0,0,0.08)");
    r.style.setProperty("--border-accent",  "rgba(0,0,0,0.15)");
    r.style.setProperty("--chart-tick",     "#999999");
    r.style.setProperty("--chart-grid",     "rgba(0,0,0,0.06)");
  } else { // dark (default)
    r.style.setProperty("--bg-base",        "#0a0a0a");
    r.style.setProperty("--bg-surface",     "#111111");
    r.style.setProperty("--bg-elevated",    "#1a1a1a");
    r.style.setProperty("--bg-hover",       "#222222");
    r.style.setProperty("--text-primary",   "#f0f0f0");
    r.style.setProperty("--text-secondary", "#888888");
    r.style.setProperty("--text-muted",     "#444444");
    r.style.setProperty("--border",         "rgba(255,255,255,0.07)");
    r.style.setProperty("--border-accent",  "rgba(255,255,255,0.15)");
    r.style.setProperty("--chart-tick",     "#666666");
    r.style.setProperty("--chart-grid",     "rgba(255,255,255,0.04)");
  }
}

export function updateChartColors(...charts) {
  const tick = getComputedStyle(document.documentElement).getPropertyValue("--chart-tick").trim() || "#666";
  const grid = getComputedStyle(document.documentElement).getPropertyValue("--chart-grid").trim() || "rgba(255,255,255,0.04)";
  charts.forEach(chart => {
    if (!chart) return;
    const scales = chart.options?.scales || {};
    ["x", "y"].forEach(axis => {
      if (!scales[axis]) return;
      if (!scales[axis].ticks) scales[axis].ticks = {};
      if (!scales[axis].grid)  scales[axis].grid  = {};
      scales[axis].ticks.color = tick;
      scales[axis].grid.color  = grid;
    });
    chart.update("none");
  });
}
