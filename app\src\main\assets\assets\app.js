(() => {
  'use strict';

  const STORAGE_KEY = 'ritm-driver-planner-v1';
  const DEFAULT_CITY = { name: 'Краснодар', lat: 45.0355, lon: 38.9753, timezone: 'Europe/Moscow' };
  const MONTH_SEEDS = {};
  const defaultState = {
    profile: {
      carMake: '', carModel: '', serviceClass: '', fuelConsumption: 0,
      fuelPrice: 0, monthlyGoal: 200000, workingDays: 24, maxShiftHours: 9,
      cityName: DEFAULT_CITY.name, cityLat: DEFAULT_CITY.lat, cityLon: DEFAULT_CITY.lon, timezone: DEFAULT_CITY.timezone
    },
    shifts: [], events: [], remoteEvents: [], remoteEventsAt: 0, weather: null, weatherAt: 0
  };
  let state = loadState();
  let CITY = cityFromProfile(state.profile);
  let deferredInstallPrompt = null;
  let toastTimer = 0;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return structuredClone(defaultState);
      return {
        ...structuredClone(defaultState), ...saved,
        profile: { ...defaultState.profile, ...(saved.profile || {}) },
        shifts: Array.isArray(saved.shifts) ? saved.shifts : [],
        events: Array.isArray(saved.events) ? saved.events : [],
        remoteEvents: Array.isArray(saved.remoteEvents) ? saved.remoteEvents : []
      };
    } catch { return structuredClone(defaultState); }
  }

  function cityFromProfile(profile) {
    return {
      name: String(profile.cityName || DEFAULT_CITY.name),
      lat: Number(profile.cityLat) || DEFAULT_CITY.lat,
      lon: Number(profile.cityLon) || DEFAULT_CITY.lon,
      timezone: String(profile.timezone || DEFAULT_CITY.timezone)
    };
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch { showToast('Не удалось сохранить данные браузера. Освободи место и попробуй снова.'); }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function money(value, decimals = 0) {
    const number = Number(value) || 0;
    return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(number);
  }

  function compactMoney(value) {
    const number = Number(value) || 0;
    if (Math.abs(number) >= 1000000) return `${(number / 1000000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} млн`;
    if (Math.abs(number) >= 10000) return `${(number / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} тыс.`;
    return money(number);
  }

  function moscowToday() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CITY.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const part = name => parts.find(item => item.type === name)?.value || '00';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function moscowHourKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CITY.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const part = name => parts.find(item => item.type === name)?.value || '00';
    return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}`;
  }

  function addDays(iso, amount) {
    const [year, month, day] = iso.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1, day + amount, 12));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  }

  function daysInMonth(iso) {
    const [year, month] = iso.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function dayNumber(iso) { return Number(iso.slice(-2)); }
  function monthKey(iso) { return iso.slice(0, 7); }
  function cityDate(iso, time = '12:00') {
    const [year, month, day] = iso.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const utc = Date.UTC(year, month - 1, day, hour, minute || 0);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CITY.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(utc));
    const part = name => Number(parts.find(item => item.type === name)?.value || 0);
    const represented = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
    return new Date(utc - (represented - utc));
  }
  function shortDate(iso) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: CITY.timezone, day: 'numeric', month: 'short' }).format(cityDate(iso)).replace('.', '');
  }
  function weekdayShort(iso) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: CITY.timezone, weekday: 'short' }).format(cityDate(iso)).replace('.', '');
  }
  function weekdayFull(iso) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: CITY.timezone, weekday: 'long' }).format(cityDate(iso));
  }
  function russianMonth(iso) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: CITY.timezone, month: 'long' }).format(cityDate(iso));
  }
  function weekdayIndex(iso) { return new Date(`${iso}T12:00:00Z`).getUTCDay(); }
  function timeMinutes(time) {
    const [h, m] = String(time || '00:00').split(':').map(Number);
    return h * 60 + m;
  }
  function shiftHours(shift) {
    let duration = timeMinutes(shift.end) - timeMinutes(shift.start);
    if (duration <= 0) duration += 1440;
    return duration / 60;
  }

  function getMonthReport(iso = moscowToday()) {
    const key = monthKey(iso);
    const seed = MONTH_SEEDS[key];
    const shifts = state.shifts.filter(item => monthKey(item.date) === key);
    let income = seed?.income || 0;
    let bonus = 0;
    for (const item of shifts) {
      if (!seed || item.date > seed.asOf) {
        income += Number(item.income) || 0;
        bonus += Number(item.bonus) || 0;
      }
    }
    return { income: income + bonus, ordersIncome: income, bonus, shifts, seeded: Boolean(seed), seed };
  }

  function getFuelCost(km) {
    return (Number(km) || 0) * (Number(state.profile.fuelConsumption) || 0) / 100 * (Number(state.profile.fuelPrice) || 0);
  }

  function getObservedRate() {
    const usable = state.shifts.filter(item => shiftHours(item) > 0);
    const hours = usable.reduce((sum, item) => sum + shiftHours(item), 0);
    if (!hours || !Number(state.profile.fuelConsumption) || !Number(state.profile.fuelPrice)) return { rate: 0, appRate: 0, hours: 0, count: usable.length };
    const total = usable.reduce((sum, item) => sum + (Number(item.income) || 0) + (Number(item.bonus) || 0), 0);
    const fuel = usable.reduce((sum, item) => sum + getFuelCost(item.km), 0);
    return { rate: Math.max(0, (total - fuel) / hours), appRate: total / hours, hours, count: usable.length };
  }

  function slotPart(hour) {
    if (hour >= 5 && hour < 10) return 'утро';
    if (hour >= 10 && hour < 16) return 'день';
    if (hour >= 16 && hour < 21) return 'вечер';
    return 'поздно';
  }

  function personalAdjustment(part) {
    const byPart = new Map();
    for (const shift of state.shifts) {
      const hour = Number(String(shift.start).split(':')[0]);
      const key = slotPart(hour);
      const hours = shiftHours(shift);
      const value = ((Number(shift.income) || 0) + (Number(shift.bonus) || 0) - getFuelCost(shift.km)) / Math.max(hours, .5);
      const item = byPart.get(key) || { total: 0, count: 0 };
      item.total += value; item.count++;
      byPart.set(key, item);
    }
    const own = byPart.get(part);
    if (!own || own.count < 2) return 0;
    const all = [...byPart.values()].filter(item => item.count >= 1);
    const base = all.reduce((sum, item) => sum + item.total, 0) / all.reduce((sum, item) => sum + item.count, 0);
    if (!base) return 0;
    return Math.max(-8, Math.min(8, ((own.total / own.count / base) - 1) * 18));
  }

  function hourDate(date, hour) { return cityDate(date, `${String(hour).padStart(2, '0')}:00`); }
  function weatherAt(date, hour) {
    const value = state.weather?.[`${date}T${String(hour).padStart(2, '0')}`];
    return value || null;
  }

  function eventDateObject(event) {
    if (event.startAt) return new Date(event.startAt);
    return new Date(`${event.date}T${event.time || '19:00'}:00+03:00`);
  }

  function eventScoreAt(date, hour) {
    const at = hourDate(date, hour).getTime();
    let best = null;
    for (const event of state.remoteEvents) {
      const start = eventDateObject(event).getTime();
      const distanceHours = (at - start) / 3600000;
      if (distanceHours < -1.5 || distanceHours > 2.5) continue;
      const weight = event.mass ? 18 : 9;
      const adjusted = weight - Math.abs(distanceHours) * 2.2;
      if (!best || adjusted > best.adjusted) best = { ...event, adjusted, weight, distanceHours };
    }
    return best;
  }

  function demandAt(date, hour) {
    const dow = weekdayIndex(date);
    const weekend = dow === 0 || dow === 6;
    let score = 36;
    let reason = 'обычный час';
    if (!weekend && hour >= 6 && hour <= 9) { score += 22; reason = 'утренний поток'; }
    else if (!weekend && hour >= 16 && hour <= 19) { score += 25; reason = 'вечерний поток'; }
    else if (dow === 5 && hour >= 20 && hour <= 23) { score += 23; reason = 'пятничный вечер'; }
    else if (dow === 6 && hour >= 18 && hour <= 23) { score += 24; reason = 'субботний вечер'; }
    else if (weekend && hour >= 11 && hour <= 15) { score += 9; reason = 'выходной день'; }
    else if (weekend && hour >= 7 && hour <= 10) { score += 4; reason = 'утро выходного'; }

    const weather = weatherAt(date, hour);
    if (weather) {
      const rainy = (weather.precipitation || 0) >= .15 || (weather.precipitation_probability || 0) >= 55 || [51, 53, 55, 61, 63, 65, 71, 73, 75, 80, 81, 82, 95, 96, 99].includes(weather.weather_code);
      if (rainy) { score += 11; reason += ' · осадки'; }
      if ((weather.wind_speed_10m || 0) >= 45) score += 3;
    }

    const event = eventScoreAt(date, hour);
    if (event) { score += event.adjusted; reason += ` · событие: ${event.title}`; }
    score += personalAdjustment(slotPart(hour));
    return { score: Math.max(25, Math.min(98, Math.round(score))), reason, event, weather, part: slotPart(hour) };
  }

  function currentLocalHour() {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone: CITY.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  }

  function hourIsFuture(date, hour) {
    const key = `${date}T${String(hour).padStart(2, '0')}`;
    if (date > moscowToday()) return true;
    if (date < moscowToday()) return false;
    const now = Number(new Intl.DateTimeFormat('en-GB', { timeZone: CITY.timezone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const minute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: CITY.timezone, minute: '2-digit' }).format(new Date()));
    return key.slice(-2) > String(now).padStart(2, '0') || (hour === now && minute < 50);
  }

  function candidateHours(date) {
    const dow = weekdayIndex(date);
    const weekend = dow === 0 || dow === 6;
    const hours = new Set();
    for (let hour = 6; hour <= 9; hour++) hours.add(hour);
    for (let hour = 16; hour <= 22; hour++) hours.add(hour);
    if (weekend) for (let hour = 11; hour <= 14; hour++) hours.add(hour);
    return [...hours].filter(hour => hourIsFuture(date, hour));
  }

  function bestWindows() {
    const windows = [];
    const today = moscowToday();
    for (let offset = 0; offset < 7; offset++) {
      const date = addDays(today, offset);
      const ranges = [[6, 10, 'Утренний выезд'], [11, 15, 'Дневной спрос'], [16, 20, 'Вечерний пик'], [20, 23, 'Поздний вечер']];
      for (const [start, end, title] of ranges) {
        if (start === 11 && ![0, 6].includes(weekdayIndex(date))) continue;
        const slots = [];
        for (let hour = start; hour < end; hour++) if (hourIsFuture(date, hour)) slots.push(demandAt(date, hour));
        if (!slots.length) continue;
        const score = Math.round(slots.reduce((sum, item) => sum + item.score, 0) / slots.length);
        const event = slots.map(item => item.event).filter(Boolean).sort((a, b) => b.adjusted - a.adjusted)[0];
        windows.push({ date, start, end, title, score, event, weather: slots.some(item => item.reason.includes('осадки')) });
      }
    }
    windows.sort((a, b) => b.score - a.score);
    const selected = [];
    const perDate = new Map();
    for (const item of windows) {
      if ((perDate.get(item.date) || 0) >= 2) continue;
      selected.push(item); perDate.set(item.date, (perDate.get(item.date) || 0) + 1);
      if (selected.length >= 6) break;
    }
    return selected;
  }

  function monthGoalMath(report = getMonthReport()) {
    const rate = getObservedRate().rate;
    const goal = Number(state.profile.monthlyGoal) || 200000;
    const remaining = Math.max(0, goal - report.income);
    const goalHours = rate > 0 ? goal / rate : 0;
    const workdayHours = Number(state.profile.workingDays) > 0 ? goalHours / Number(state.profile.workingDays) : 0;
    const today = moscowToday();
    const calendarLeft = Math.max(0, daysInMonth(today) - dayNumber(today));
    const estimatedWorkdaysLeft = Math.max(0, Math.min(calendarLeft, Math.round(Number(state.profile.workingDays) * calendarLeft / daysInMonth(today))));
    const catchupHours = rate > 0 ? remaining / rate : 0;
    return { rate, goal, remaining, goalHours, workdayHours, calendarLeft, estimatedWorkdaysLeft, catchupHours, catchupDaily: estimatedWorkdaysLeft ? catchupHours / estimatedWorkdaysLeft : 0 };
  }

  function slotsForDate(date) {
    return candidateHours(date).map(hour => ({ hour, ...demandAt(date, hour) }));
  }

  function groupSlots(selected) {
    const sorted = [...selected].sort((a, b) => a.hour - b.hour);
    const groups = [];
    for (const slot of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.end === slot.hour) { last.end++; last.scoreValues.push(slot.score); if (slot.event && (!last.event || slot.event.adjusted > last.event.adjusted)) last.event = slot.event; }
      else groups.push({ start: slot.hour, end: slot.hour + 1, scoreValues: [slot.score], event: slot.event || null });
    }
    return groups;
  }

  function createAutoPlan() {
    const today = moscowToday();
    const math = monthGoalMath();
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i)).map(date => {
      const slots = slotsForDate(date);
      const top = [...slots].sort((a, b) => b.score - a.score).slice(0, Math.min(5, slots.length));
      const dayScore = top.length ? Math.round(top.reduce((sum, item) => sum + item.score, 0) / top.length) : 25;
      return { date, slots, dayScore };
    });
    const dim = daysInMonth(today);
    const weeklyWorkdays = Math.max(1, Math.min(7, Math.round((Number(state.profile.workingDays) || 24) / dim * 7)));
    const activeCount = Math.min(days.length, weeklyWorkdays);
    const activeDates = new Set([...days].sort((a, b) => b.dayScore - a.dayScore).slice(0, activeCount).map(item => item.date));
    const shiftCap = Math.max(1, Math.min(18, Number(state.profile.maxShiftHours) || 9));
    let plannedHoursPerDay = Math.ceil(math.workdayHours || shiftCap);
    if (monthKey(today) === '2026-11' && math.calendarLeft > 0 && math.estimatedWorkdaysLeft > 0) plannedHoursPerDay = Math.ceil(math.catchupDaily || plannedHoursPerDay);
    plannedHoursPerDay = math.remaining <= 0 ? 0 : Math.max(1, Math.min(shiftCap, plannedHoursPerDay));
    const plan = days.map(day => {
      if (!activeDates.has(day.date)) return { ...day, selected: [], blocks: [], rest: true };
      const selected = [...day.slots].sort((a, b) => b.score - a.score).slice(0, plannedHoursPerDay).sort((a, b) => a.hour - b.hour);
      return { ...day, selected, blocks: groupSlots(selected), rest: selected.length === 0 };
    });
    const totalHours = plan.reduce((sum, day) => sum + day.selected.length, 0);
    const average = plan.filter(day => day.selected.length).reduce((sum, day) => sum + day.dayScore, 0) / (plan.filter(day => day.selected.length).length || 1);
    return { plan, totalHours, average: Math.round(average), activeCount, plannedHoursPerDay, math };
  }

  function scoreClass(score) { return score >= 75 ? '' : score >= 58 ? 'medium' : 'low'; }
  function scoreWord(score) { return score >= 75 ? 'выше среднего' : score >= 58 ? 'средний' : 'умеренный'; }
  function mapLink(place) { return `https://yandex.ru/maps/?text=${encodeURIComponent(place || CITY.name)}`; }
  function recommendedZone(date, start, end, event) {
    if (event) return event.venue || 'площадка события';
    if (start >= 6 && start < 10) return 'жилые районы → центр';
    if (start >= 16 && start < 20) return 'центр → жилые районы';
    if (start >= 20) return 'центр, рестораны и площадки';
    if (start >= 11 && start < 16) return 'парки и торговые центры';
    return 'центральные районы';
  }

  function renderOverview() {
    const today = moscowToday();
    const report = getMonthReport(today);
    const math = monthGoalMath(report);
    const pct = Math.min(100, math.goal ? report.income / math.goal * 100 : 0);
    document.getElementById('today-label').textContent = `${weekdayFull(today).toLocaleUpperCase('ru-RU')} · ${shortDate(today).toLocaleUpperCase('ru-RU')}`;
    const h = currentLocalHour();
    document.getElementById('overview-title').textContent = h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
    document.getElementById('city-label').textContent = CITY.name;
    const carName = `${state.profile.carMake} ${state.profile.carModel}`.trim();
    document.getElementById('car-label').textContent = carName ? `${carName} · ${state.profile.serviceClass || 'тариф не указан'}` : 'добавь автомобиль в профиле';
    document.getElementById('month-earned').textContent = money(report.income);
    document.getElementById('goal-total').textContent = money(math.goal);
    document.getElementById('goal-progress-bar').style.width = `${pct}%`;
    document.getElementById('goal-progress-text').textContent = `${money(pct, 0)}% выполнено`;
    document.getElementById('goal-days-text').textContent = `${money(math.remaining)} ₽ осталось`;
    document.getElementById('goal-percent').textContent = `${Math.round(pct)}%`;
    document.getElementById('goal-ring').style.setProperty('--progress', `${pct}%`);
    const rate = getObservedRate().rate;
    document.getElementById('net-hour').textContent = rate ? `${money(rate)} ₽` : '—';
    const fuelReady = Number(state.profile.fuelConsumption) > 0 && Number(state.profile.fuelPrice) > 0;
    document.getElementById('fuel-100').textContent = fuelReady ? `${money(state.profile.fuelConsumption * state.profile.fuelPrice)} ₽` : 'укажи в профиле';
    document.querySelector('.metric-caption').textContent = fuelReady ? `${money(state.profile.fuelConsumption)} л / 100 км` : 'расход и цена топлива';
    document.getElementById('target-headline').textContent = math.remaining ? `Ещё ${money(math.remaining)} ₽` : 'Цель достигнута';
    document.getElementById('goal-remaining').textContent = `${money(math.remaining)} ₽`;
    document.getElementById('hours-month').textContent = rate ? `${money(math.goalHours, 1)} ч` : 'нет данных';
    document.getElementById('hours-workday').textContent = rate ? `${money(math.workdayHours, 1)} ч` : 'нет данных';
    document.getElementById('target-caveat').textContent = rate ? `Расчёт по ${getObservedRate().count} ${getObservedRate().count === 1 ? 'подробной смене' : 'записям смен'}: после топлива; ремонт, мойка и износ не включены.` : 'Добавь смену, чтобы приложение оценило доходность часа.';
    const plan = createAutoPlan();
    const summaryDays = plan.plan.filter(item => item.selected.length).slice(0, 3);
    document.getElementById('overview-plan').innerHTML = summaryDays.length ? summaryDays.map(item => {
      const first = item.blocks[0];
      const last = item.blocks[item.blocks.length - 1];
      const time = item.blocks.map(block => `${String(block.start).padStart(2, '0')}:00–${String(block.end).padStart(2, '0')}:00`).join(' + ');
      return `<div class="plan-day"><div class="plan-date"><b>${escapeHtml(shortDate(item.date))}</b><small>${escapeHtml(weekdayShort(item.date))}</small></div><div class="plan-day-main"><strong>${escapeHtml(time)}</strong><small>${escapeHtml(recommendedZone(item.date, first?.start || 16, last?.end || 20, first?.event || last?.event))}</small></div><span class="demand-score ${scoreClass(item.dayScore)}">${item.dayScore}/100</span></div>`;
    }).join('') : '<div class="empty-list">Обновляю прогноз на ближайшие часы…</div>';
  }

  function renderWeather() {
    const key = moscowHourKey();
    const forecast = state.weather?.[key];
    const all = Object.entries(state.weather || {}).sort((a, b) => {
      const atA = new Date(`${a[0]}:00+03:00`).getTime();
      const atB = new Date(`${b[0]}:00+03:00`).getTime();
      return Math.abs(atA - Date.now()) - Math.abs(atB - Date.now());
    });
    const nearest = forecast || all[0]?.[1];
    const weatherStatus = document.getElementById('weather-status');
    const dot = document.getElementById('weather-status-dot');
    if (nearest) {
      const descriptor = weatherDescription(nearest.weather_code);
      document.getElementById('weather-icon').textContent = weatherEmoji(nearest.weather_code);
      document.getElementById('weather-now').textContent = `${Math.round(nearest.temperature_2m)}°`;
      document.getElementById('weather-summary').textContent = descriptor;
      document.getElementById('weather-rain').textContent = `${Math.round(nearest.precipitation_probability || 0)}%`;
      document.getElementById('weather-wind').textContent = `${Math.round(nearest.wind_speed_10m || 0)} км/ч`;
      document.getElementById('weather-location').textContent = `${CITY.name} · ${forecast ? 'сейчас' : 'последний доступный прогноз'}`;
      const at = state.weatherAt ? `Обновлено ${new Date(state.weatherAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Погода обновлена';
      weatherStatus.textContent = state.weatherAt ? `${at} · прогноз на 7 дней` : 'Прогноз погоды на 7 дней';
      dot.parentElement.classList.remove('offline');
    } else {
      document.getElementById('weather-icon').textContent = '☁';
      document.getElementById('weather-now').textContent = '—';
      document.getElementById('weather-summary').textContent = 'нет связи с прогнозом';
      document.getElementById('weather-rain').textContent = '—';
      document.getElementById('weather-wind').textContent = '—';
      weatherStatus.textContent = 'Погода пока недоступна · расчёт без неё';
      dot.parentElement.classList.add('offline');
    }
  }

  function weatherDescription(code) {
    if ([0].includes(code)) return 'ясно';
    if ([1, 2].includes(code)) return 'малооблачно';
    if ([3].includes(code)) return 'облачно';
    if ([45, 48].includes(code)) return 'туман';
    if ([51, 53, 55].includes(code)) return 'морось';
    if ([61, 63, 65, 80, 81, 82].includes(code)) return 'дождь';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'снег';
    if ([95, 96, 99].includes(code)) return 'гроза';
    return 'переменная погода';
  }
  function weatherEmoji(code) {
    if (code === 0) return '☀';
    if ([1, 2].includes(code)) return '🌤';
    if ([3, 45, 48].includes(code)) return '☁';
    if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return '🌧';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '❄';
    if ([95, 96, 99].includes(code)) return '⛈';
    return '🌤';
  }

  function renderForecast() {
    renderWeather();
    const auto = createAutoPlan();
    const need = auto.math;
    const title = document.getElementById('auto-plan-title');
    const summary = document.getElementById('auto-plan-summary');
    const rate = getObservedRate().rate;
    title.textContent = math.remaining <= 0 ? 'Цель достигнута · можно отдыхать' : `${auto.activeCount} смен · до ${auto.plannedHoursPerDay} ч в день`;
    let basis = state.weatherAt ? 'План обновлён по погоде и афише.' : 'План предварительный: жду прогноз погоды.';
    if (state.remoteEventsAt) basis += ` Афиша обновлена ${new Date(state.remoteEventsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}.`;
    summary.textContent = `${basis} Ставлю сильные часы выше; индекс спроса ранжирует окна, а не обещает сумму заказов.`;

    document.getElementById('weekly-plan').innerHTML = auto.plan.map(item => {
      const selectedGroups = item.blocks;
      const chips = item.rest ? '<span class="time-chip rest">отдых</span>' : selectedGroups.map(group => {
        const event = group.event;
        const cls = event ? 'time-chip event' : 'time-chip';
        return `<span class="${cls}" title="${escapeHtml(group.event ? `${event.title} · ${event.venue}` : '')}">${String(group.start).padStart(2, '0')}:00–${String(group.end).padStart(2, '0')}:00</span>`;
      }).join('');
      const score = item.rest ? '' : `<span class="weekly-score">${item.dayScore}</span>`;
      return `<div class="weekly-day"><div class="weekly-day-date"><b>${escapeHtml(shortDate(item.date))}</b><small>${escapeHtml(weekdayShort(item.date))}</small></div><div class="weekly-blocks">${chips}</div>${score}</div>`;
    }).join('');

    const safety = document.getElementById('safety-note');
    const shiftCap = Math.max(1, Math.min(18, Number(state.profile.maxShiftHours) || 9));
    if (need.remaining <= 0) {
      safety.textContent = 'Месячная цель по внесённым данным выполнена.';
    } else if (!rate) {
      safety.textContent = 'Пока нет записанных смен: часы ранжированы по типичным пикам, погоде и событиям. Добавь смены, чтобы оценить заработок и нужную длительность.';
    } else if (monthKey(moscowToday()) === '2026-11' && need.catchupDaily > shiftCap) {
      safety.textContent = rate ? `Чтобы добрать цель до конца ноября, по текущей смене нужно около ${money(need.catchupDaily, 1)} ч на каждый из ${need.estimatedWorkdaysLeft} расчётных рабочих дней. Автоплан ограничивает смену заданным пределом ${shiftCap} ч: при нынешнем темпе цель до конца месяца не сходится.` : 'Добавь подробную смену, чтобы оценить нужную длительность графика.';
    } else if (need.workdayHours > shiftCap) {
      safety.textContent = `На цель нужно примерно ${money(need.workdayHours, 1)} ч за каждый рабочий день. Автоплан показывает заданный предел ${shiftCap} ч и отдаёт предпочтение более сильным окнам.`;
    } else {
      safety.textContent = `План строится по ${money(need.workdayHours, 1)} ч за рабочий день, предел — ${shiftCap} ч.`;
    }

    const windows = bestWindows();
    document.getElementById('windows-list').innerHTML = windows.length ? windows.map(item => {
      const zone = recommendedZone(item.date, item.start, item.end, item.event);
      const titlePart = item.event ? item.event.title : item.title;
      const weatherTag = item.weather ? ' · осадки могут поднять спрос' : '';
      return `<div class="window-card"><div class="window-day"><b>${escapeHtml(shortDate(item.date).split(' ')[0])}</b><small>${escapeHtml(weekdayShort(item.date))}</small></div><div class="window-info"><strong>${escapeHtml(titlePart)} · ${String(item.start).padStart(2, '0')}:00–${String(item.end).padStart(2, '0')}:00</strong><small>${escapeHtml(zone)}${escapeHtml(weatherTag)} <a class="zone-map" href="${escapeHtml(mapLink(zone))}" target="_blank" rel="noreferrer">карта ↗</a></small></div><div class="window-meta"><b class="demand-score ${scoreClass(item.score)}">${item.score}/100</b><small>${scoreWord(item.score)}</small></div></div>`;
    }).join('') : '<div class="empty-list">Обновляю почасовой прогноз.</div>';
    renderEvents();
  }

  function eventTimeForSort(event) { return eventDateObject(event).getTime() || 0; }
  function renderEvents() {
    if (CITY.name.trim().toLocaleLowerCase('ru-RU') !== 'краснодар') {
      document.getElementById('events-count').textContent = 'город не подключён';
      document.getElementById('events-list').innerHTML = '<div class="empty-events">Автоматическая афиша сейчас подключена только для Краснодара. Погода и планирование часов продолжают работать для выбранного города.</div>';
      return;
    }
    const events = state.remoteEvents.filter(event => event.date >= moscowToday()).sort((a, b) => eventTimeForSort(a) - eventTimeForSort(b));
    const count = document.getElementById('events-count');
    count.textContent = events.length ? `${events.length} событий` : 'нет событий';
    const container = document.getElementById('events-list');
    if (!events.length) {
      if (!state.remoteEventsAt) {
        container.innerHTML = '<div class="loading-line"><span class="spinner"></span>Загружаю афишу на ближайшие дни</div>';
      } else {
        container.innerHTML = '<div class="empty-events">В афише не нашлись ближайшие события или источник пока недоступен. <a href="https://afisha-krasnodar.ru/list/all/" target="_blank" rel="noreferrer">Открыть афишу ↗</a></div>';
      }
      return;
    }
    container.innerHTML = events.slice(0, 9).map(event => {
      const dateText = `${shortDate(event.date)} · ${weekdayShort(event.date)}`;
      return `<article class="event-card"><div class="event-time"><b>${escapeHtml(event.time || '—')}</b>${escapeHtml(shortDate(event.date).split(' ')[0])}</div><div class="event-info"><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(event.venue || 'Краснодар')} · ${escapeHtml(dateText)}${event.mass ? ' · возможный пик после события' : ''}</small><a href="${escapeHtml(event.url || event.sourceUrl)}" target="_blank" rel="noreferrer">афиша события ↗</a><span class="event-source-tag">${event.mass ? 'массовое' : 'городское'}</span></div></article>`;
    }).join('');
  }

  function renderJournal() {
    const all = [...state.shifts].sort((a, b) => `${b.date}T${b.start}`.localeCompare(`${a.date}T${a.start}`));
    const current = getMonthReport();
    const rate = getObservedRate();
    const fuelReady = Number(state.profile.fuelConsumption) > 0 && Number(state.profile.fuelPrice) > 0;
    const fuel = current.shifts.reduce((sum, item) => sum + getFuelCost(item.km), 0);
    document.getElementById('journal-summary').innerHTML = `<div class="journal-kpi"><small>смен записано</small><b>${rate.count}</b></div><div class="journal-kpi"><small>среднее после бензина</small><b>${rate.rate ? `${money(rate.rate)} ₽/ч` : '—'}</b></div><div class="journal-kpi"><small>топливо по журналу</small><b>${fuelReady ? `${money(fuel)} ₽` : 'укажи цену'}</b></div>`;
    document.getElementById('shift-list').innerHTML = all.length ? all.map(shift => {
      const hours = shiftHours(shift);
      const gross = (Number(shift.income) || 0) + (Number(shift.bonus) || 0);
      const fuelCost = getFuelCost(shift.km);
      const afterFuel = fuelReady ? gross - fuelCost : null;
      return `<article class="shift-card"><div class="shift-card-top"><div><strong>${escapeHtml(shortDate(shift.date))} · ${escapeHtml(weekdayShort(shift.date))}</strong><div class="shift-date">${escapeHtml(shift.start)}–${escapeHtml(shift.end)} · ${money(hours, 1)} ч</div></div><div class="shift-income">${money(gross)} ₽<small>до топлива</small></div></div><div class="shift-tags"><span class="shift-tag">${money(shift.rides)} заказов</span><span class="shift-tag">${money(shift.km || 0, 1)} км</span><span class="shift-tag good">${fuelReady ? `после топлива ${money(afterFuel)} ₽` : 'укажи расход и цену топлива'}</span>${fuelReady ? `<span class="shift-tag">${money(hours ? afterFuel / hours : 0)} ₽/ч</span>` : ''}</div>${shift.note ? `<div class="shift-bottom"><span class="shift-note">${escapeHtml(shift.note)}</span><button class="delete-shift" data-delete-shift="${escapeHtml(shift.id)}">удалить</button></div>` : `<div class="shift-bottom"><span></span><button class="delete-shift" data-delete-shift="${escapeHtml(shift.id)}">удалить</button></div>`}</article>`;
    }).join('') : '<div class="empty-list">Пока нет смен. Добавь первую, и журнал начнёт сравнивать дни и часы.</div>';
  }

  function renderProfile() {
    const form = document.getElementById('profile-form');
    for (const [key, value] of Object.entries(state.profile)) if (form.elements[key]) form.elements[key].value = value;
    const make = state.profile.carMake || '';
    const model = state.profile.carModel || '';
    document.getElementById('car-title').textContent = `${make} ${model}`.trim() || 'Автомобиль не указан';
    document.getElementById('class-label').textContent = state.profile.serviceClass || 'класс не указан';
    document.getElementById('profile-city-label').textContent = CITY.name;
    document.getElementById('car-consumption-label').textContent = Number(state.profile.fuelConsumption) > 0 ? `${money(state.profile.fuelConsumption, 1)} л / 100 км` : 'расход не указан';
  }

  function renderAll() {
    renderOverview();
    renderForecast();
    renderJournal();
    renderProfile();
  }

  function setPage(name) {
    for (const section of document.querySelectorAll('.page-section')) section.classList.toggle('active', section.id === `${name}-page`);
    for (const button of document.querySelectorAll('.nav-item')) button.classList.toggle('active', button.dataset.page === name);
    if (name === 'forecast') renderForecast();
    if (name === 'journal') renderJournal();
    if (name === 'profile') renderProfile();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setSyncLabel(text, offline = false) {
    const label = document.getElementById('sync-label');
    label.textContent = text;
    label.parentElement.classList.toggle('offline', offline);
  }

  function showToast(text) {
    const element = document.getElementById('toast');
    element.textContent = text;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2500);
  }

  async function geocodeCity(name) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
    url.search = new URLSearchParams({ name, count: '10', language: 'ru', format: 'json', countryCode: 'RU' }).toString();
    try {
      const response = await fetch(url.toString(), { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) return null;
      const results = (await response.json()).results || [];
      const found = results.find(item => item.name?.toLocaleLowerCase('ru-RU') === name.toLocaleLowerCase('ru-RU')) || results[0];
      if (!found) return null;
      return { name: found.name, lat: Number(found.latitude), lon: Number(found.longitude), timezone: found.timezone || DEFAULT_CITY.timezone };
    } catch { return null; }
  }

  async function fetchWeather(force = false) {
    const fresh = state.weatherAt && Date.now() - state.weatherAt < 3 * 60 * 60 * 1000;
    if (!force && fresh) return true;
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({
      latitude: CITY.lat, longitude: CITY.lon,
      hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m',
      current: 'temperature_2m,precipitation,weather_code,wind_speed_10m',
      timezone: CITY.timezone, forecast_days: '7'
    }).toString();
    try {
      const response = await fetch(url.toString(), { cache: 'no-store', signal: AbortSignal.timeout(16000) });
      if (!response.ok) throw new Error(`weather ${response.status}`);
      const data = await response.json();
      const byHour = {};
      const hourly = data.hourly || {};
      for (let i = 0; i < (hourly.time || []).length; i++) {
        const time = hourly.time[i];
        byHour[time.slice(0, 13)] = {
          temperature_2m: hourly.temperature_2m?.[i], precipitation_probability: hourly.precipitation_probability?.[i] || 0,
          precipitation: hourly.precipitation?.[i] || 0, weather_code: hourly.weather_code?.[i] || 0,
          wind_speed_10m: hourly.wind_speed_10m?.[i] || 0
        };
      }
      if (data.current) {
        const nowKey = moscowHourKey();
        byHour[nowKey] = { ...(byHour[nowKey] || {}), ...data.current };
      }
      state.weather = byHour;
      state.weatherAt = Date.now();
      saveState();
      return true;
    } catch (error) {
      console.warn('Не удалось получить прогноз погоды', error);
      return Boolean(state.weather && Object.keys(state.weather).length);
    }
  }

  function calendarUrl(date) {
    const [year, month, day] = date.split('-');
    return `https://afisha-krasnodar.ru/list/all/${day}-${month}-${year}/`;
  }

  function stripLinks(markdown) {
    return String(markdown || '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]+)\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\*_`>#]/g, ' ');
  }

  function cleanLine(line) { return line.replace(/\s+/g, ' ').replace(/^[\s|•·-]+|[\s|•·-]+$/g, '').trim(); }
  function lineIsUi(line) {
    return !line || /^(?:купить билеты|подробнее|все события|назад|вперёд|вперед|ещё события|смотреть все|афиша краснодара|популярные события|категории|концерты|театр|кино|для детей|вечеринки|музеи|мастер-классы|подборки|вход свободный|бесплатно|[0-9]{1,2}\+|страница \d+|\d+ из \d+|активных событий)(?:\s*[↗→!:.]|$)/i.test(line) || /^\d{1,2}\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(,?\s*(пн|вт|ср|чт|пт|сб|вс))?$/i.test(line);
  }
  function seemsDateTime(line) { return /\b\d{1,2}:\d{2}\b/.test(line) && /(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|пн|вт|ср|чт|пт|сб|вс)/i.test(line); }
  function isMassEvent(title, venue) {
    return /(стадион|арена|матч|фк\b|футбол|баскет|хоккей|концерт|фестиваль|ярмарк|экспоград|дворец спорта|олимп|ozon|кроп arena|кроп арена|большой зал|праздник города)/i.test(`${title} ${venue}`);
  }

  function parseAfisha(markdown, date) {
    const original = String(markdown || '');
    const links = new Map();
    for (const match of original.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]+)\)/g)) {
      const title = cleanLine(match[1]);
      let href = match[2];
      if (href.startsWith('/')) href = `https://afisha-krasnodar.ru${href}`;
      if (title && href.includes('afisha-krasnodar.ru')) links.set(title, href);
    }
    const lines = stripLinks(original).split(/\r?\n/).map(cleanLine).filter(Boolean);
    const result = [];
    const ignoredTime = /^(?:\d{1,2}:\d{2}\s*)+$/;
    function priorCandidates(index) {
      const found = [];
      for (let j = index - 1; j >= 0 && found.length < 4; j--) {
        const candidate = lines[j];
        if (!candidate || ignoredTime.test(candidate) || lineIsUi(candidate) || seemsDateTime(candidate)) continue;
        found.push(candidate);
      }
      return found;
    }
    function nextCandidates(index) {
      const found = [];
      for (let j = index + 1; j < lines.length && found.length < 4; j++) {
        const candidate = lines[j];
        if (!candidate || ignoredTime.test(candidate) || lineIsUi(candidate) || seemsDateTime(candidate)) continue;
        if (/^\d{1,2}:\d{2}$/.test(candidate)) continue;
        found.push(candidate);
      }
      return found;
    }
    const timePattern = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
    for (let index = 0; index < lines.length; index++) {
      const times = [...lines[index].matchAll(timePattern)].map(match => `${String(match[1]).padStart(2, '0')}:${match[2]}`);
      if (!times.length) continue;
      let title = '';
      let venue = '';
      if (seemsDateTime(lines[index])) {
        const after = nextCandidates(index);
        title = after[0] || ''; venue = after[1] || '';
      } else {
        const before = priorCandidates(index);
        venue = before[0] || '';
        title = before[1] || before[0] || '';
        if (!before[1]) {
          const after = nextCandidates(index);
          title = after[0] || title; venue = after[1] || venue;
        }
      }
      if (!title || lineIsUi(title) || seemsDateTime(title)) continue;
      if (venue === title) venue = '';
      for (const time of [...new Set(times)]) {
        const id = `${date}|${time}|${title}|${venue}`;
        result.push({
          id, date, time, title, venue: venue || CITY.name,
          startAt: `${date}T${time}:00+03:00`, mass: isMassEvent(title, venue),
          url: links.get(title) || calendarUrl(date), sourceUrl: calendarUrl(date)
        });
      }
    }
    const unique = new Map();
    for (const event of result) if (!unique.has(event.id)) unique.set(event.id, event);
    return [...unique.values()];
  }

  async function fetchEvents(force = false) {
    if (CITY.name.trim().toLocaleLowerCase('ru-RU') !== 'краснодар') {
      state.remoteEvents = [];
      state.remoteEventsAt = Date.now();
      saveState();
      return true;
    }
    const fresh = state.remoteEventsAt && Date.now() - state.remoteEventsAt < 3 * 60 * 60 * 1000;
    if (!force && fresh) return true;
    const today = moscowToday();
    document.getElementById('events-list').classList.add('events-refreshing');
    const dates = Array.from({ length: 7 }, (_, i) => addDays(today, i));
    const results = await Promise.allSettled(dates.map(async date => {
      const readerUrl = `https://r.jina.ai/${calendarUrl(date)}`;
      const response = await fetch(readerUrl, { cache: 'no-store', signal: AbortSignal.timeout(26000) });
      if (!response.ok) throw new Error(`events ${response.status}`);
      const text = await response.text();
      return parseAfisha(text, date);
    }));
    const loaded = results.filter(result => result.status === 'fulfilled').flatMap(result => result.value);
    const succeeded = results.filter(result => result.status === 'fulfilled').length;
    document.getElementById('events-list').classList.remove('events-refreshing');
    if (loaded.length) {
      const map = new Map();
      for (const event of loaded) map.set(event.id, event);
      state.remoteEvents = [...map.values()].sort((a, b) => eventDateObject(a) - eventDateObject(b)).slice(0, 250);
      state.remoteEventsAt = Date.now();
      saveState();
      return true;
    }
    if (succeeded > 0) {
      state.remoteEvents = [];
      state.remoteEventsAt = Date.now();
      saveState();
      return true;
    }
    return Boolean(state.remoteEvents.length);
  }

  async function refreshAll(force = false) {
    const button1 = document.getElementById('refresh-button');
    const button2 = document.getElementById('forecast-refresh');
    button1.classList.add('spin'); button2.classList.add('spin');
    setSyncLabel('обновляю прогноз');
    const [weatherOk, eventsOk] = await Promise.all([fetchWeather(force), fetchEvents(force)]);
    button1.classList.remove('spin'); button2.classList.remove('spin');
    const ok = weatherOk || eventsOk;
    const updated = Math.max(state.weatherAt || 0, state.remoteEventsAt || 0);
    setSyncLabel(ok ? `обновлено ${updated ? new Date(updated).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''}` : 'нет связи', !ok);
    renderAll();
    return ok;
  }

  function bindEvents() {
    document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page)));
    document.getElementById('settings-shortcut').addEventListener('click', () => setPage('profile'));
    document.getElementById('refresh-button').addEventListener('click', () => refreshAll(true));
    document.getElementById('forecast-refresh').addEventListener('click', () => refreshAll(true));
    document.getElementById('shift-form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const shift = {
        id: `shift-${Date.now()}`, date: data.get('date'), start: data.get('start'), end: data.get('end'),
        rides: Number(data.get('rides')) || 0, income: Number(data.get('income')) || 0,
        km: Number(data.get('km')) || 0, bonus: Number(data.get('bonus')) || 0,
        note: String(data.get('note') || '').trim(), source: 'manual'
      };
      if (!shift.date || shiftHours(shift) <= 0) { showToast('Проверь дату и время смены.'); return; }
      state.shifts.push(shift); saveState(); form.reset();
      form.elements.date.value = moscowToday(); form.elements.start.value = '16:00'; form.elements.end.value = '20:00'; form.elements.bonus.value = '0'; form.elements.rides.value = '0';
      renderAll(); showToast('Смена сохранена на этом устройстве.');
    });
    document.getElementById('profile-form').addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const requestedCity = String(data.get('cityName') || '').trim();
      if (!requestedCity) { showToast('Укажи город для прогноза погоды.'); return; }
      const fuelConsumption = Number(data.get('fuelConsumption'));
      const fuelPrice = Number(data.get('fuelPrice'));
      if (!(fuelConsumption > 0) || !(fuelPrice > 0)) { showToast('Укажи расход автомобиля и цену топлива.'); return; }
      let selectedCity = CITY;
      if (requestedCity.toLocaleLowerCase('ru-RU') !== CITY.name.toLocaleLowerCase('ru-RU')) {
        selectedCity = await geocodeCity(requestedCity);
        if (!selectedCity) { showToast('Не нашла такой город в России. Проверь написание.'); return; }
      }
      const cityChanged = selectedCity.name.toLocaleLowerCase('ru-RU') !== CITY.name.toLocaleLowerCase('ru-RU');
      CITY = selectedCity;
      state.profile = {
        carMake: String(data.get('carMake') || '').trim(),
        carModel: String(data.get('carModel') || '').trim(),
        serviceClass: String(data.get('serviceClass') || '').trim(),
        monthlyGoal: Math.max(10000, Number(data.get('monthlyGoal')) || 200000),
        fuelConsumption,
        fuelPrice,
        workingDays: Math.max(1, Math.min(31, Number(data.get('workingDays')) || 24)),
        maxShiftHours: Math.max(1, Math.min(18, Number(data.get('maxShiftHours')) || 9)),
        cityName: CITY.name, cityLat: CITY.lat, cityLon: CITY.lon, timezone: CITY.timezone
      };
      if (cityChanged) { state.weather = null; state.weatherAt = 0; state.remoteEvents = []; state.remoteEventsAt = 0; }
      saveState(); renderAll(); setPage('overview'); showToast('Профиль сохранён.');
      if (cityChanged) refreshAll(true);
    });
    document.getElementById('shift-list').addEventListener('click', event => {
      const button = event.target.closest('[data-delete-shift]');
      if (!button) return;
      state.shifts = state.shifts.filter(item => item.id !== button.dataset.deleteShift);
      saveState(); renderAll(); showToast('Запись смены удалена.');
    });
    document.getElementById('export-button').addEventListener('click', exportCsv);
    document.getElementById('install-button').addEventListener('click', async () => {
      if (!deferredInstallPrompt) { showToast('Открой меню Chrome и выбери «Установить приложение».'); return; }
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      document.getElementById('install-button').hidden = true;
    });
  }

  function exportCsv() {
    const headers = ['Дата', 'Начало', 'Окончание', 'Часы', 'Заказы', 'Доход, ₽', 'Бонус, ₽', 'Пробег, км', 'Топливо, ₽', 'После топлива, ₽', 'Заметка'];
    const rows = [...state.shifts].sort((a, b) => a.date.localeCompare(b.date)).map(item => [
      item.date, item.start, item.end, shiftHours(item).toFixed(2), item.rides, item.income, item.bonus || 0,
      item.km || 0, getFuelCost(item.km).toFixed(2), ((Number(item.income) || 0) + (Number(item.bonus) || 0) - getFuelCost(item.km)).toFixed(2), item.note || ''
    ]);
    const csv = [headers, ...rows].map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = 'ritm-smeny.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function initInstall() {
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); deferredInstallPrompt = event;
      document.getElementById('install-button').hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      document.getElementById('install-button').hidden = true;
      showToast('Ритм установлен.');
    });
  }

  function initServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Офлайн-кэш не подключился', error));
    }
  }

  function init() {
    const today = moscowToday();
    const dateInput = document.querySelector('#shift-form [name="date"]');
    dateInput.value = today;
    bindEvents(); initInstall(); initServiceWorker(); renderAll();
    refreshAll(false);
    setInterval(() => refreshAll(false), 3 * 60 * 60 * 1000);
    window.addEventListener('online', () => refreshAll(true));
  }

  document.addEventListener('DOMContentLoaded', init);
})();
