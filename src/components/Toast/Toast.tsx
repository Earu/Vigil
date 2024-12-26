import { useEffect, useState } from 'react';
import './Toast.css';

export interface Toast {
	id: string;
	message: string;
	type: 'success' | 'error';
}

interface ToastProps {
	toast: Toast;
	onRemove: (id: string) => void;
}

const ToastItem = ({ toast, onRemove }: ToastProps) => {
	useEffect(() => {
		const timer = setTimeout(() => {
			onRemove(toast.id);
		}, 3000);

		return () => clearTimeout(timer);
	}, [toast.id, onRemove]);

	return (
		<div className={`toast ${toast.type}`}>
			{toast.type === 'success' && (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="#10b981"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ width: '16px', height: '16px' }}
				>
					<path d="M20 6L9 17l-5-5" />
				</svg>
			)}
			{toast.type === 'error' && (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="#ef4444"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ width: '16px', height: '16px' }}
				>
					<circle cx="12" cy="12" r="10" />
					<line x1="15" y1="9" x2="9" y2="15" />
					<line x1="9" y1="9" x2="15" y2="15" />
				</svg>
			)}
			{toast.message}
		</div>
	);
};

export const ToastContainer = () => {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const addToast = (toast: Omit<Toast, 'id'>) => {
		const id = Math.random().toString(36).substring(7);
		setToasts((prev) => [...prev, { ...toast, id }]);
	};

	const removeToast = (id: string) => {
		setToasts((prev) => prev.filter((toast) => toast.id !== id));
	};

	// Expose the addToast function globally
	useEffect(() => {
		(window as any).showToast = addToast;
		return () => {
			delete (window as any).showToast;
		};
	}, []);

	return (
		<div className="toast-container">
			{toasts.map((toast) => (
				<ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
			))}
		</div>
	);
}; 