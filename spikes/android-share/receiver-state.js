/**
 * Share-receiver readiness, as its own explicit state.
 *
 * C02 / R01 F7. Registration failure previously set the single page status to
 * "Nie udało się uruchomić obsługi offline." Two things were wrong with that:
 * it named offline support rather than share capture, which is what actually
 * breaks; and it shared one status line with the local form, so the next
 * successful simulate/login wrote over it and the page looked healthy again.
 *
 * Receiver state is therefore computed here, owned by its own status element,
 * and never written by form operations.
 *
 * Registration and control are different facts. A registered worker does not
 * control the current page until it activates and claims it, and only a
 * CONTROLLING worker can intercept `POST /share-target`. Reporting "registered"
 * as "ready" would be the same overclaim in a new place.
 *
 * Nothing here can remove an installed OS share target. If the receiver is
 * unavailable, the system entry may still exist and the share simply will not be
 * captured — the messages say exactly that and no more.
 */

export const RECEIVER_STATES = {
  unsupported: {
    shareCaptureAvailable: false,
    severity: "error",
    message:
      "Ta przeglądarka nie obsługuje Service Workera. Przechwytywanie udostępnień jest niedostępne — "
      + "udostępnienie wysłane z systemu nie zostanie tutaj zapisane.",
  },
  registration_failed: {
    shareCaptureAvailable: false,
    severity: "error",
    message:
      "Rejestracja odbiornika udostępnień nie powiodła się. Przechwytywanie udostępnień jest niedostępne — "
      + "udostępnienie wysłane z systemu nie zostanie tutaj zapisane.",
  },
  registered_not_controlling: {
    shareCaptureAvailable: false,
    severity: "warning",
    message:
      "Odbiornik udostępnień jest zarejestrowany, ale nie kontroluje jeszcze tej strony. "
      + "Przechwytywanie udostępnień zacznie działać po ponownym otwarciu strony.",
  },
  ready: {
    shareCaptureAvailable: true,
    severity: "ok",
    message: "Odbiornik udostępnień jest aktywny i kontroluje tę stronę.",
  },
};

/**
 * Decide receiver state from observable facts.
 *
 * @param {object} input
 * @param {boolean} input.serviceWorkerSupported  `"serviceWorker" in navigator`
 * @param {boolean} input.registered              registration resolved
 * @param {boolean} input.controlling             `navigator.serviceWorker.controller` is set
 */
export function receiverState({ serviceWorkerSupported, registered, controlling }) {
  const state = !serviceWorkerSupported
    ? "unsupported"
    : !registered
      ? "registration_failed"
      : controlling
        ? "ready"
        : "registered_not_controlling";
  return { state, ...RECEIVER_STATES[state] };
}

/**
 * Read the live browser facts. Separated from `receiverState` so the decision
 * table is testable without a browser.
 */
export async function observeReceiver(navigatorRef, registerOptions = { scope: "./", type: "module" }) {
  if (!navigatorRef || !("serviceWorker" in navigatorRef)) {
    return receiverState({ serviceWorkerSupported: false, registered: false, controlling: false });
  }
  let registered = false;
  try {
    await navigatorRef.serviceWorker.register("sw.js", registerOptions);
    registered = true;
  } catch {
    registered = false;
  }
  return receiverState({
    serviceWorkerSupported: true,
    registered,
    // Control, not registration. `controller` is null until an activated worker
    // has claimed this client.
    controlling: Boolean(navigatorRef.serviceWorker.controller),
  });
}

/**
 * Keep the receiver state live.
 *
 * C02-R3: the page observed registration and controller once. A first install
 * legitimately reports `registered_not_controlling`, then the worker activates and
 * `clients.claim()` grants control — but the visible message stayed stale, so the
 * UI claimed share capture was unavailable when it had just become available. Loss
 * or replacement of the controller was equally invisible.
 *
 * `controllerchange` is the event that actually marks control changing hands, so
 * the state is recomputed from it. Registration happens exactly once: re-running
 * `register()` on every event would be a different bug.
 *
 * `onState` is called with the initial state and again on every change. Returns a
 * detach function. The navigator is injected so an event-capable double can drive
 * acquisition and loss of control without a browser.
 */
export function watchReceiver(navigatorRef, onState, registerOptions) {
  let detached = false;
  const emit = (state) => { if (!detached) onState(state); };

  if (!navigatorRef || !("serviceWorker" in navigatorRef)) {
    emit(receiverState({ serviceWorkerSupported: false, registered: false, controlling: false }));
    return () => { detached = true; };
  }

  const container = navigatorRef.serviceWorker;
  let registered = false;

  // Recompute from current facts only. No re-registration.
  const refresh = () => emit(receiverState({
    serviceWorkerSupported: true,
    registered,
    controlling: Boolean(container.controller),
  }));

  const onControllerChange = () => refresh();
  container.addEventListener?.("controllerchange", onControllerChange);

  observeReceiver(navigatorRef, registerOptions).then((initial) => {
    registered = initial.state !== "registration_failed" && initial.state !== "unsupported";
    emit(initial);
  });

  return () => {
    detached = true;
    container.removeEventListener?.("controllerchange", onControllerChange);
  };
}
