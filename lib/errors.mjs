export class AppError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function requireObject(value, label = '请求') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, `${label}格式不正确。`, 'INVALID_INPUT');
  }
  return value;
}

export function boundedString(value, label, maxLength, { optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (!optional && !value.trim())) {
    throw new AppError(400, `请填写${label}。`, 'INVALID_INPUT');
  }
  if (value.length > maxLength) {
    throw new AppError(400, `${label}过长，最多支持 ${maxLength} 个字符。`, 'INPUT_TOO_LARGE');
  }
  return value.trim();
}
