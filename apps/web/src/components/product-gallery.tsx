'use client';
import { useState } from 'react';
import type { Product } from '@productspy/shared';
import { ProductImage } from './ui';

export function ProductGallery({ product }: { product: Product }) {
  const images = [
    ...new Set([product.mainImage, ...product.images].filter((url): url is string => Boolean(url))),
  ];
  const [selected, setSelected] = useState<string>();
  const current = selected && images.includes(selected) ? selected : images[0];
  return (
    <div>
      <ProductImage src={current} alt={product.title} className="gallery-main" />
      {images.length > 0 && (
        <div className="gallery-thumbs" aria-label="商品图片 Gallery">
          {images.map((image, index) => (
            <button
              key={image}
              type="button"
              className={image === current ? 'active' : ''}
              onClick={() => setSelected(image)}
              aria-label={`查看商品图片 ${index + 1}`}
              aria-pressed={image === current}
            >
              <ProductImage src={image} alt={`${product.title} 图片 ${index + 1}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
