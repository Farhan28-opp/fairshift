// Read-aloud and voice input using the phone's built-in speech engines.
// Both are optional: every screen works with text alone, and the buttons only
// appear when the browser supports them.

const VOICE_LANG = { en: 'en-IN', ta: 'ta-IN' };
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canSpeak = () => 'speechSynthesis' in window;
export const canListen = () => Boolean(Recognition);

function voiceFor(lang) {
  const tag = VOICE_LANG[lang] || 'en-IN';
  const base = tag.slice(0, 2);
  const voices = window.speechSynthesis.getVoices();
  return {
    tag,
    voices,
    voice: voices.find((v) => v.lang.replace('_', '-') === tag) || voices.find((v) => v.lang.toLowerCase().startsWith(base)) || null,
  };
}

/**
 * Speaks `text` in `lang`. Returns false (and says nothing) when the device has
 * no voice for that language, rather than reading Tamil with an English voice.
 */
export function speak(text, lang, onEnd) {
  if (!canSpeak() || !text) return false;
  const { tag, voices, voice } = voiceFor(lang);
  if (voices.length && !voice) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = tag;
  if (voice) utterance.voice = voice;
  utterance.rate = 0.9;
  utterance.onend = () => onEnd?.();
  utterance.onerror = () => onEnd?.();
  window.speechSynthesis.speak(utterance);
  return true;
}

export function stopSpeaking() {
  if (canSpeak()) window.speechSynthesis.cancel();
}

// Voices load asynchronously in some browsers; ask early so the first tap works.
if (canSpeak()) window.speechSynthesis.getVoices();

/** Starts dictation in the worker's language; returns a stop function. */
export function listen(lang, { onText, onEnd, onError }) {
  const rec = new Recognition();
  rec.lang = VOICE_LANG[lang] || 'en-IN';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (event) => {
    onText(Array.from(event.results, (r) => r[0].transcript).join(' '));
  };
  rec.onend = () => onEnd?.();
  rec.onerror = (event) => {
    onError?.(event.error);
    onEnd?.();
  };
  rec.start();
  return () => rec.stop();
}
