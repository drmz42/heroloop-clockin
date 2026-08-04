import { useEffect, useRef } from 'react';

export function ChestCollectIcon({ size = 38 }: { size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const image = new Image();
    image.src = '/assets/ui/open-treasure-chest-v1.png';
    image.onload = () => {
      const canvas = ref.current;
      if (!canvas) return;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        const red = pixels.data[index]; const green = pixels.data[index + 1]; const blue = pixels.data[index + 2];
        const dominance = green - Math.max(red, blue);
        if (green > 90 && dominance > 25) pixels.data[index + 3] = Math.max(0, 255 - dominance * 3.2);
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.putImageData(pixels, 0, 0);
    };
  }, []);
  return <canvas ref={ref} width={128} height={128} style={{ width: size, height: size }} aria-hidden="true" />;
}
