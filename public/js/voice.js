// Read-aloud and voice input using the phone's built-in speech engines.
// No audio leaves the phone through FairShift; Android's own engine handles it.

const VOICE_LANG = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const canSpeak = () => 'speechSynthesis' in window;
export const canListen = () => Boolean(Recognition);

export function speak(text, lang, onEnd) {
  if (!canSpeak()) return false;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const tag = VOICE_LANG[lang] || 'en-IN';
  utterance.lang = tag;
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').startsWith(tag));
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

/** Starts dictation; returns a stop function. */
export function listen(lang, { onText, onEnd }) {
  const rec = new Recognition();
  rec.lang = VOICE_LANG[lang] || 'en-IN';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (event) => {
    const text = Array.from(event.results, (r) => r[0].transcript).join(' ');
    onText(text);
  };
  rec.onend = () => onEnd?.();
  rec.onerror = () => onEnd?.();
  rec.start();
  return () => rec.stop();
}
