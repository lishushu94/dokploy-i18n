import type { TFunction } from "next-i18next";

/**
 * 翻译错误消息
 * 如果错误消息是翻译键（以 settings. 或 common. 开头），则尝试翻译
 * 否则返回原始消息
 */
export function translateErrorMessage(
	errorMessage: string,
	t: TFunction,
): string {
	// 检查是否是翻译键格式
	if (
		errorMessage.startsWith("settings.") ||
		errorMessage.startsWith("common.") ||
		errorMessage.startsWith("auth.")
	) {
		const translated = t(errorMessage);
		// 如果翻译结果与键相同，说明翻译键不存在，返回原始消息
		if (translated === errorMessage) {
			return errorMessage;
		}
		return translated;
	}
	return errorMessage;
}

