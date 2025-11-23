
export const analyzeNewsWithGemini = async (news, apiKey) => {
    if (!apiKey || !news || news.length === 0) return null;

    const prompt = `
    You are a professional crypto trading analyst. Analyze the following news headlines and determine the immediate market sentiment.
    
    Headlines:
    ${news.map(n => "- " + n.title).join('\n')}

    Respond ONLY with a valid JSON object (no markdown formatting) containing:
    {
      "score": <number between -10 (Extreme Bearish) and 10 (Extreme Bullish)>,
      "reasoning": "<short explanation, max 10 words>"
    }
  `;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        const data = await response.json();

        if (data.error) {
            console.error("Gemini API Error:", data.error);
            return null;
        }

        const text = data.candidates[0].content.parts[0].text;

        // Clean up potential markdown code blocks
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();

        return JSON.parse(cleanText);
    } catch (error) {
        console.error("Gemini Request Failed:", error);
        return null;
    }
};
