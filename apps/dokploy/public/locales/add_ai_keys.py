#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
为所有语言文件添加缺失的 AI 键
"""
import json
from pathlib import Path

# 英文参考值
en_keys = {
    "ai.steps.title": "Steps",
    "ai.steps.progress": "Step {{current}} / {{total}}",
    "ai.steps.needs": "Describe your needs",
    "ai.steps.variant": "Select a variant",
    "ai.stepTwo.loadingTitle": "Processing your AI request",
    "ai.stepTwo.loadingDescription": "Generating template suggestions based on your input...",
    "ai.stepTwo.title": "Step 2: Select a Variant",
    "ai.stepTwo.suggestionsIntro": "Based on your input, we suggest the following template variants:"
}

# 土耳其语参考值（已翻译）
tr_keys = {
    "ai.steps.title": "Adımlar",
    "ai.steps.progress": "Adım {{current}} / {{total}}",
    "ai.steps.needs": "İhtiyaçlarınızı açıklayın",
    "ai.steps.variant": "Bir varyant seçin",
    "ai.stepTwo.loadingTitle": "Yapay zekâ isteğinizi işliyor",
    "ai.stepTwo.loadingDescription": "Girdinize göre şablon önerileri oluşturuluyor...",
    "ai.stepTwo.title": "Adım 2: Bir Varyant Seçin",
    "ai.stepTwo.suggestionsIntro": "Girdinize göre aşağıdaki şablon varyantlarını öneriyoruz:"
}

# 语言翻译映射（暂时使用英文，后续可手动翻译）
translations = {
    "az": {  # 阿塞拜疆语 - 使用英文占位
        "ai.steps.title": "Steps",
        "ai.steps.progress": "Addım {{current}} / {{total}}",
        "ai.steps.needs": "Ehtiyaclarınızı təsvir edin",
        "ai.steps.variant": "Variant seçin",
        "ai.stepTwo.loadingTitle": "AI sorğunuz işlənir",
        "ai.stepTwo.loadingDescription": "Girişinizə əsasən şablon təklifləri yaradılır...",
        "ai.stepTwo.title": "Addım 2: Variant Seçin",
        "ai.stepTwo.suggestionsIntro": "Girişinizə əsasən aşağıdakı şablon variantlarını təklif edirik:"
    },
    "de": {  # 德语
        "ai.steps.title": "Schritte",
        "ai.steps.progress": "Schritt {{current}} / {{total}}",
        "ai.steps.needs": "Beschreiben Sie Ihre Anforderungen",
        "ai.steps.variant": "Variante auswählen",
        "ai.stepTwo.loadingTitle": "Ihre KI-Anfrage wird verarbeitet",
        "ai.stepTwo.loadingDescription": "Vorlagenvorschläge werden basierend auf Ihrer Eingabe generiert...",
        "ai.stepTwo.title": "Schritt 2: Variante auswählen",
        "ai.stepTwo.suggestionsIntro": "Basierend auf Ihrer Eingabe schlagen wir die folgenden Vorlagenvarianten vor:"
    },
    "es": {  # 西班牙语
        "ai.steps.title": "Pasos",
        "ai.steps.progress": "Paso {{current}} / {{total}}",
        "ai.steps.needs": "Describe tus necesidades",
        "ai.steps.variant": "Selecciona una variante",
        "ai.stepTwo.loadingTitle": "Procesando tu solicitud de IA",
        "ai.stepTwo.loadingDescription": "Generando sugerencias de plantillas basadas en tu entrada...",
        "ai.stepTwo.title": "Paso 2: Selecciona una Variante",
        "ai.stepTwo.suggestionsIntro": "Basándonos en tu entrada, sugerimos las siguientes variantes de plantilla:"
    },
    "fa": {  # 波斯语
        "ai.steps.title": "مراحل",
        "ai.steps.progress": "مرحله {{current}} / {{total}}",
        "ai.steps.needs": "نیازهای خود را شرح دهید",
        "ai.steps.variant": "یک نوع را انتخاب کنید",
        "ai.stepTwo.loadingTitle": "در حال پردازش درخواست هوش مصنوعی شما",
        "ai.stepTwo.loadingDescription": "در حال تولید پیشنهادات قالب بر اساس ورودی شما...",
        "ai.stepTwo.title": "مرحله 2: یک نوع را انتخاب کنید",
        "ai.stepTwo.suggestionsIntro": "بر اساس ورودی شما، انواع قالب زیر را پیشنهاد می‌کنیم:"
    },
    "fr": {  # 法语
        "ai.steps.title": "Étapes",
        "ai.steps.progress": "Étape {{current}} / {{total}}",
        "ai.steps.needs": "Décrivez vos besoins",
        "ai.steps.variant": "Sélectionner une variante",
        "ai.stepTwo.loadingTitle": "Traitement de votre demande d'IA",
        "ai.stepTwo.loadingDescription": "Génération de suggestions de modèles basées sur votre saisie...",
        "ai.stepTwo.title": "Étape 2 : Sélectionner une variante",
        "ai.stepTwo.suggestionsIntro": "Sur la base de votre saisie, nous suggérons les variantes de modèles suivantes :"
    },
    "id": {  # 印尼语
        "ai.steps.title": "Langkah",
        "ai.steps.progress": "Langkah {{current}} / {{total}}",
        "ai.steps.needs": "Jelaskan kebutuhan Anda",
        "ai.steps.variant": "Pilih varian",
        "ai.stepTwo.loadingTitle": "Memproses permintaan AI Anda",
        "ai.stepTwo.loadingDescription": "Menghasilkan saran template berdasarkan input Anda...",
        "ai.stepTwo.title": "Langkah 2: Pilih Varian",
        "ai.stepTwo.suggestionsIntro": "Berdasarkan input Anda, kami menyarankan varian template berikut:"
    },
    "it": {  # 意大利语
        "ai.steps.title": "Passaggi",
        "ai.steps.progress": "Passaggio {{current}} / {{total}}",
        "ai.steps.needs": "Descrivi le tue esigenze",
        "ai.steps.variant": "Seleziona una variante",
        "ai.stepTwo.loadingTitle": "Elaborazione della tua richiesta AI",
        "ai.stepTwo.loadingDescription": "Generazione di suggerimenti per template basati sul tuo input...",
        "ai.stepTwo.title": "Passaggio 2: Seleziona una variante",
        "ai.stepTwo.suggestionsIntro": "In base al tuo input, suggeriamo le seguenti varianti di template:"
    },
    "ja": {  # 日语
        "ai.steps.title": "ステップ",
        "ai.steps.progress": "ステップ {{current}} / {{total}}",
        "ai.steps.needs": "ニーズを説明してください",
        "ai.steps.variant": "バリアントを選択",
        "ai.stepTwo.loadingTitle": "AIリクエストを処理中",
        "ai.stepTwo.loadingDescription": "入力に基づいてテンプレートの提案を生成しています...",
        "ai.stepTwo.title": "ステップ 2: バリアントを選択",
        "ai.stepTwo.suggestionsIntro": "入力に基づいて、以下のテンプレートバリアントを提案します:"
    },
    "ko": {  # 韩语
        "ai.steps.title": "단계",
        "ai.steps.progress": "단계 {{current}} / {{total}}",
        "ai.steps.needs": "요구사항을 설명하세요",
        "ai.steps.variant": "변형 선택",
        "ai.stepTwo.loadingTitle": "AI 요청 처리 중",
        "ai.stepTwo.loadingDescription": "입력에 따라 템플릿 제안을 생성하는 중...",
        "ai.stepTwo.title": "단계 2: 변형 선택",
        "ai.stepTwo.suggestionsIntro": "입력에 따라 다음 템플릿 변형을 제안합니다:"
    },
    "kz": {  # 哈萨克语
        "ai.steps.title": "Қадамдар",
        "ai.steps.progress": "Қадам {{current}} / {{total}}",
        "ai.steps.needs": "Қажеттіліктеріңізді сипаттаңыз",
        "ai.steps.variant": "Вариант таңдаңыз",
        "ai.stepTwo.loadingTitle": "AI сұрауыңыз өңделуде",
        "ai.stepTwo.loadingDescription": "Енгізілген деректерге сүйене отырып, үлгі ұсыныстары жасалуда...",
        "ai.stepTwo.title": "Қадам 2: Вариант таңдаңыз",
        "ai.stepTwo.suggestionsIntro": "Енгізілген деректерге сүйене отырып, біз келесі үлгі варианттарын ұсынамыз:"
    },
    "ml": {  # 马拉雅拉姆语
        "ai.steps.title": "ഘട്ടങ്ങൾ",
        "ai.steps.progress": "ഘട്ടം {{current}} / {{total}}",
        "ai.steps.needs": "നിങ്ങളുടെ ആവശ്യങ്ങൾ വിവരിക്കുക",
        "ai.steps.variant": "ഒരു വകഭേദം തിരഞ്ഞെടുക്കുക",
        "ai.stepTwo.loadingTitle": "നിങ്ങളുടെ AI അഭ്യർത്ഥന പ്രോസസ്സ് ചെയ്യുന്നു",
        "ai.stepTwo.loadingDescription": "നിങ്ങളുടെ ഇൻപുട്ടിനെ അടിസ്ഥാനമാക്കി ടെംപ്ലേറ്റ് നിർദ്ദേശങ്ങൾ സൃഷ്ടിക്കുന്നു...",
        "ai.stepTwo.title": "ഘട്ടം 2: ഒരു വകഭേദം തിരഞ്ഞെടുക്കുക",
        "ai.stepTwo.suggestionsIntro": "നിങ്ങളുടെ ഇൻപുട്ടിനെ അടിസ്ഥാനമാക്കി, ഇനിപ്പറയുന്ന ടെംപ്ലേറ്റ് വകഭേദങ്ങൾ ഞങ്ങൾ നിർദ്ദേശിക്കുന്നു:"
    },
    "nl": {  # 荷兰语
        "ai.steps.title": "Stappen",
        "ai.steps.progress": "Stap {{current}} / {{total}}",
        "ai.steps.needs": "Beschrijf uw behoeften",
        "ai.steps.variant": "Selecteer een variant",
        "ai.stepTwo.loadingTitle": "Uw AI-verzoek wordt verwerkt",
        "ai.stepTwo.loadingDescription": "Sjabloonsuggesties genereren op basis van uw invoer...",
        "ai.stepTwo.title": "Stap 2: Selecteer een variant",
        "ai.stepTwo.suggestionsIntro": "Op basis van uw invoer stellen we de volgende sjabloonvarianten voor:"
    },
    "no": {  # 挪威语
        "ai.steps.title": "Steg",
        "ai.steps.progress": "Steg {{current}} / {{total}}",
        "ai.steps.needs": "Beskriv behovene dine",
        "ai.steps.variant": "Velg en variant",
        "ai.stepTwo.loadingTitle": "Behandler din AI-forespørsel",
        "ai.stepTwo.loadingDescription": "Genererer mal-forslag basert på din inndata...",
        "ai.stepTwo.title": "Steg 2: Velg en variant",
        "ai.stepTwo.suggestionsIntro": "Basert på din inndata foreslår vi følgende mal-varianter:"
    },
    "pl": {  # 波兰语
        "ai.steps.title": "Kroki",
        "ai.steps.progress": "Krok {{current}} / {{total}}",
        "ai.steps.needs": "Opisz swoje potrzeby",
        "ai.steps.variant": "Wybierz wariant",
        "ai.stepTwo.loadingTitle": "Przetwarzanie żądania AI",
        "ai.stepTwo.loadingDescription": "Generowanie sugestii szablonów na podstawie wprowadzonych danych...",
        "ai.stepTwo.title": "Krok 2: Wybierz wariant",
        "ai.stepTwo.suggestionsIntro": "Na podstawie wprowadzonych danych sugerujemy następujące warianty szablonów:"
    },
    "pt-br": {  # 巴西葡萄牙语
        "ai.steps.title": "Passos",
        "ai.steps.progress": "Passo {{current}} / {{total}}",
        "ai.steps.needs": "Descreva suas necessidades",
        "ai.steps.variant": "Selecione uma variante",
        "ai.stepTwo.loadingTitle": "Processando sua solicitação de IA",
        "ai.stepTwo.loadingDescription": "Gerando sugestões de modelo com base na sua entrada...",
        "ai.stepTwo.title": "Passo 2: Selecione uma Variante",
        "ai.stepTwo.suggestionsIntro": "Com base na sua entrada, sugerimos as seguintes variantes de modelo:"
    },
    "ru": {  # 俄语
        "ai.steps.title": "Шаги",
        "ai.steps.progress": "Шаг {{current}} / {{total}}",
        "ai.steps.needs": "Опишите свои потребности",
        "ai.steps.variant": "Выберите вариант",
        "ai.stepTwo.loadingTitle": "Обработка вашего запроса ИИ",
        "ai.stepTwo.loadingDescription": "Генерация предложений шаблонов на основе вашего ввода...",
        "ai.stepTwo.title": "Шаг 2: Выберите вариант",
        "ai.stepTwo.suggestionsIntro": "На основе вашего ввода мы предлагаем следующие варианты шаблонов:"
    },
    "uk": {  # 乌克兰语
        "ai.steps.title": "Кроки",
        "ai.steps.progress": "Крок {{current}} / {{total}}",
        "ai.steps.needs": "Опишіть свої потреби",
        "ai.steps.variant": "Виберіть варіант",
        "ai.stepTwo.loadingTitle": "Обробка вашого запиту ШІ",
        "ai.stepTwo.loadingDescription": "Генерація пропозицій шаблонів на основі вашого вводу...",
        "ai.stepTwo.title": "Крок 2: Виберіть варіант",
        "ai.stepTwo.suggestionsIntro": "На основі вашого вводу ми пропонуємо наступні варіанти шаблонів:"
    },
    "zh-Hans": {  # 简体中文
        "ai.steps.title": "步骤",
        "ai.steps.progress": "步骤 {{current}} / {{total}}",
        "ai.steps.needs": "描述您的需求",
        "ai.steps.variant": "选择变体",
        "ai.stepTwo.loadingTitle": "正在处理您的 AI 请求",
        "ai.stepTwo.loadingDescription": "正在根据您的输入生成模板建议...",
        "ai.stepTwo.title": "步骤 2: 选择变体",
        "ai.stepTwo.suggestionsIntro": "根据您的输入，我们建议以下模板变体:"
    },
    "zh-Hant": {  # 繁体中文
        "ai.steps.title": "步驟",
        "ai.steps.progress": "步驟 {{current}} / {{total}}",
        "ai.steps.needs": "描述您的需求",
        "ai.steps.variant": "選擇變體",
        "ai.stepTwo.loadingTitle": "正在處理您的 AI 請求",
        "ai.stepTwo.loadingDescription": "正在根據您的輸入生成模板建議...",
        "ai.stepTwo.title": "步驟 2: 選擇變體",
        "ai.stepTwo.suggestionsIntro": "根據您的輸入，我們建議以下模板變體:"
    }
}

def add_keys_to_file(lang_code, file_path):
    """为指定语言文件添加缺失的键"""
    try:
        # 读取文件
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # 获取该语言的翻译
        lang_translations = translations.get(lang_code, en_keys)
        
        # 添加缺失的键
        added_count = 0
        for key, value in lang_translations.items():
            if key not in data:
                data[key] = value
                added_count += 1
        
        if added_count > 0:
            # 重新格式化并保存
            formatted_content = json.dumps(data, ensure_ascii=False, indent=4)
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(formatted_content)
            return True, added_count
        else:
            return True, 0
    except Exception as e:
        return False, str(e)

def main():
    """主函数"""
    script_dir = Path(__file__).parent
    lang_dirs = sorted([d for d in script_dir.iterdir() if d.is_dir() and not d.name.startswith('.')])
    
    print("开始为所有语言文件添加 AI 键...\n")
    print("=" * 70)
    
    success_count = 0
    error_count = 0
    
    for lang_dir in lang_dirs:
        lang_code = lang_dir.name
        file_path = lang_dir / 'common.json'
        
        # 跳过 en 和 tr（已有完整键）
        if lang_code in ['en', 'tr']:
            print(f"✓ {lang_code}: 已包含所有键，跳过")
            continue
        
        if not file_path.exists():
            print(f"⚠️  {lang_code}: 文件不存在")
            continue
        
        success, result = add_keys_to_file(lang_code, file_path)
        
        if success:
            if result > 0:
                print(f"✓ {lang_code}: 成功添加 {result} 个键")
                success_count += 1
            else:
                print(f"✓ {lang_code}: 无需添加（键已存在）")
        else:
            print(f"✗ {lang_code}: 失败 - {result}")
            error_count += 1
    
    print("\n" + "=" * 70)
    print(f"处理完成!")
    print(f"成功: {success_count} 个文件")
    print(f"失败: {error_count} 个文件")

if __name__ == '__main__':
    main()

