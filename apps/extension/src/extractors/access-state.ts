/** Only inspect public challenge markers; never solve or submit Amazon verification. */
export function isAmazonVerificationPage(document: Document): boolean {
  return document.querySelector('form[action*="validateCaptcha" i], #captchacharacters') !== null;
}
