const DAY_SECONDS = 24 * 60 * 60;
const MOSCOW_OFFSET_SECONDS = 3 * 60 * 60;
const EARLY_WINDOW_START_SECONDS = 3 * 60 * 60;
const DAILY_WINDOW_START_SECONDS = 9 * 60 * 60;
const LEGACY_POLL_TTL_SECONDS = 3 * 60 * 60;

function validateEpochSeconds(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Expected nonnegative safe-integer epoch seconds.');
  }
}

// Half-open Moscow windows: 09:00–03:00 and 03:00–09:00.
// Fixed UTC+3 arithmetic keeps the result independent of the host timezone.
export function pollWindow(epochSeconds) {
  validateEpochSeconds(epochSeconds);
  const localSeconds = (epochSeconds % DAY_SECONDS + MOSCOW_OFFSET_SECONDS) % DAY_SECONDS;
  const localMidnight = epochSeconds - localSeconds;
  let start;
  let end;
  if (localSeconds < EARLY_WINDOW_START_SECONDS) {
    start = localMidnight - DAY_SECONDS + DAILY_WINDOW_START_SECONDS;
    end = localMidnight + EARLY_WINDOW_START_SECONDS;
  } else if (localSeconds < DAILY_WINDOW_START_SECONDS) {
    start = localMidnight + EARLY_WINDOW_START_SECONDS;
    end = localMidnight + DAILY_WINDOW_START_SECONDS;
  } else {
    start = localMidnight + DAILY_WINDOW_START_SECONDS;
    end = localMidnight + DAY_SECONDS + EARLY_WINDOW_START_SECONDS;
  }
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end)) {
    throw new RangeError('Poll window exceeds the supported epoch range.');
  }
  return { start, end };
}

// Previous releases stored creation time + 3h. New releases store a window end.
// Subtracting 3h lands inside the originating window for either representation.
export function normalizePollFence(deadline) {
  validateEpochSeconds(deadline);
  if (deadline === 0) return 0;
  return pollWindow(deadline - LEGACY_POLL_TTL_SECONDS).end;
}
