import { useEffect, useRef } from 'react';
import './Background.css';

interface Particle {
	r: number; // orbit radius, 0..1
	theta: number; // starting angle
	omega: number; // angular speed (differential: faster near the center)
	wobblePhase: number;
	wobbleAmp: number;
	size: number;
	brightness: number;
}

const PARTICLE_COUNT = 9000;
const HOLE_RADIUS = 0.06; // dark eye at the center
const TILT = 0.42; // vertical squash of the disc
const SWIRL_SPEED = 0.000012;

const buildParticles = (): Particle[] => {
	const particles: Particle[] = [];
	for (let i = 0; i < PARTICLE_COUNT; i++) {
		// Bias density toward the middle radii, thin out at the rim
		const t = Math.random();
		const r = HOLE_RADIUS + Math.pow(t, 0.7) * (1 - HOLE_RADIUS);
		particles.push({
			r,
			theta: Math.random() * Math.PI * 2,
			omega: 1 / Math.pow(r, 0.85),
			wobblePhase: Math.random() * Math.PI * 2,
			wobbleAmp: 0.004 + Math.random() * 0.02,
			size: Math.random() < 0.85 ? 1 : 2,
			brightness: 0.4 + Math.random() * 0.6,
		});
	}
	return particles;
};

export const Background = () => {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;

		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		let width = 0;
		let height = 0;
		let frame = 0;

		const resize = () => {
			width = window.innerWidth;
			height = window.innerHeight;
			canvas.width = width * dpr;
			canvas.height = height * dpr;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		};
		resize();
		window.addEventListener('resize', resize);

		const particles = buildParticles();

		const draw = (time: number) => {
			ctx.clearRect(0, 0, width, height);

			const isLight = document.documentElement.classList.contains('light-theme');
			// Muted violet-grey, dimmer counterpart on light theme
			const inner = isLight ? '90, 74, 112' : '196, 181, 224';
			const outer = isLight ? '58, 55, 70' : '150, 146, 168';

			// Eye of the vortex centered behind the auth form (below the title bar)
			const cx = width / 2;
			const cy = (height + 40) / 2;
			const scale = Math.max(width, height) * 0.95;
			const spin = time * SWIRL_SPEED;

			for (const p of particles) {
				const angle = p.theta + spin * p.omega;
				const wobble = Math.sin(time * 0.0005 + p.wobblePhase) * p.wobbleAmp;
				const r = p.r + wobble;

				const x = Math.cos(angle) * r;
				const y = Math.sin(angle) * r;
				// Faint vertical turbulence, stronger toward the rim
				const lift = Math.sin(angle * 3 + p.wobblePhase) * 0.03 * r;

				const px = cx + x * scale;
				const py = cy + (y * TILT + lift) * scale;
				if (px < -4 || px > width + 4 || py < -4 || py > height + 4) continue;

				// Spiral arms: tightly wound density modulation, smeared per particle
				// so the arms swirl instead of reading as a bar
				const arm = 0.7 + 0.3 * Math.sin(angle * 2 - Math.log(r) * 11 + p.wobblePhase * 0.35);
				// Bright ring near the eye, long falloff outward
				const glow = Math.exp(-Math.pow((r - 0.16) * 3.2, 2)) * 0.55;
				const falloff = Math.max(0, 1 - r * 0.85);
				const alpha = Math.min(0.9, (0.1 + glow + falloff * 0.25) * arm * p.brightness);
				if (alpha < 0.02) continue;

				const mix = Math.min(1, r * 1.6);
				const color = mix < 0.5 ? inner : outer;
				ctx.globalAlpha = alpha;
				ctx.fillStyle = `rgb(${color})`;
				ctx.fillRect(px, py, p.size, p.size);
			}

			ctx.globalAlpha = 1;
		};

		const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reducedMotion) {
			draw(60000);
		} else {
			const loop = (time: number) => {
				draw(time);
				frame = requestAnimationFrame(loop);
			};
			frame = requestAnimationFrame(loop);
		}

		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener('resize', resize);
		};
	}, []);

	return (
		<div className="animated-background">
			<div className="mesh-gradient"></div>
			<div className="noise"></div>
			<div className="overlay"></div>
			<canvas ref={canvasRef} className="point-cloud"></canvas>
		</div>
	);
};
