'use client';

import { useState } from 'react';
import { ExternalLink, ImageOff, RefreshCw } from 'lucide-react';
import type { Product } from '@productspy/shared';
import { Button } from './ui';
import { workspaceCopy as copy } from './workspace-copy';

export function ProductGallery({ product }: { product: Product }) {
  const images = [
    ...new Set([product.mainImage, ...product.images].filter((url): url is string => Boolean(url))),
  ];
  const [selected, setSelected] = useState<string>();
  const [failed, setFailed] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const current = selected && images.includes(selected) ? selected : images[0];
  const currentIndex = current ? images.indexOf(current) + 1 : 0;
  const currentFailed = current && failed.includes(current);
  function markFailed(url: string) {
    setFailed((values) => (values.includes(url) ? values : [...values, url]));
  }
  return (
    <div className="ws-gallery">
      <div className="ws-gallery-main">
        {current && !currentFailed ? (
          <img
            key={`${current}-${revision}`}
            src={current}
            alt={copy.gallery.alt(product.title, currentIndex)}
            referrerPolicy="no-referrer"
            onError={() => markFailed(current)}
          />
        ) : (
          <div className="ws-gallery-placeholder">
            <ImageOff size={28} />
            <p>{currentFailed ? copy.gallery.failed : copy.gallery.noImages}</p>
            {currentFailed && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFailed((values) => values.filter((url) => url !== current));
                  setRevision((value) => value + 1);
                }}
              >
                <RefreshCw size={14} />
                {copy.gallery.retry}
              </Button>
            )}
          </div>
        )}
      </div>
      {images.length > 0 && (
        <>
          <div className="ws-gallery-caption">
            <span role="status">{copy.gallery.current(currentIndex, images.length)}</span>
            <a href={current} target="_blank" rel="noreferrer" className="ws-text-link">
              {copy.gallery.original}
              <ExternalLink size={12} />
            </a>
          </div>
          <div className="ws-gallery-thumbs" role="group" aria-label={copy.gallery.label}>
            {images.map((image, index) => (
              <button
                key={image}
                type="button"
                onClick={() => setSelected(image)}
                aria-label={copy.gallery.select(index + 1)}
                aria-pressed={image === current}
              >
                {failed.includes(image) ? (
                  <ImageOff size={18} aria-hidden="true" />
                ) : (
                  <img
                    src={image}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={() => markFailed(image)}
                  />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
