// What kind of device and browser this is, for install and onboarding steps.
import { isInstalled } from './pwa.js';

const ua = navigator.userAgent;

// iPadOS reports itself as a Mac; touch support gives it away.
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);
export const isPhoneOrTablet = isIOS || isAndroid;

// Instagram, Facebook, WhatsApp, Line, Snapchat and Android web views. Google blocks sign-in there.
export const isInAppBrowser = /FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat|; wv\)/i.test(ua);

// On iPhone only Safari can add a web app to the Home Screen.
export const isIOSSafari = isIOS && !isInAppBrowser && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(ua);

export { isInstalled };

// Push needs the Push API; on iPhone it also needs the installed app (iOS 16.4+).
export function canUsePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  if (isIOS && !isInstalled()) return false;
  return true;
}

// Phones should install Folio before signing in (on iPhone the installed
// app and Safari keep separate sign-ins).
export function shouldInstallFirst() {
  return isPhoneOrTablet && !isInstalled();
}
