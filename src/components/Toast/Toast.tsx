import { useEffect, useState } from 'react';
import './Toast.css';

export interface Toast {
	id: string;
	message: string;
	type: 'success' | 'error' | 'info' | 'warning';
	duration?: number;
}

interface ToastProps {
	toast: Toast;
	onRemove: (id: string) => void;
}

const ToastItem = ({ toast, onRemove }: ToastProps) => {
	useEffect(() => {
		if (toast.duration !== 0) { // Only set timeout if duration is not 0 (persistent)
			const timer = setTimeout(() => {
				onRemove(toast.id);
			}, toast.duration || 10000);

			return () => clearTimeout(timer);
		}
	}, [toast.id, toast.duration, onRemove]);

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
			{toast.type === 'info' && (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="#3b82f6"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ width: '16px', height: '16px' }}
				>
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="16" x2="12" y2="12" />
					<line x1="12" y1="8" x2="12" y2="8" />
				</svg>
			)}
			{toast.type === 'warning' && (
				<svg
					xmlns="http://www.w3.org/2000/svg"
					viewBox="0 0 24 24"
					fill="none"
					stroke="#f59e0b"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ width: '16px', height: '16px' }}
				>
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="8" x2="12" y2="16" />
					<line x1="12" y1="8" x2="12" y2="16" />
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
		return id;
	};

	const updateToast = (id: string, newToast: Omit<Toast, 'id'>) => {
		setToasts((prev) => prev.map((toast) =>
			toast.id === id ? { ...newToast, id } : toast
		));
	};

	const removeToast = (id: string) => {
		setToasts((prev) => prev.filter((toast) => toast.id !== id));
	};

	// Expose the addToast and updateToast functions globally
	useEffect(() => {
		(window as any).showToast = addToast;
		(window as any).updateToast = updateToast;
		return () => {
			delete (window as any).showToast;
			delete (window as any).updateToast;
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