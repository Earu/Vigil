import { net } from 'electron';

const HIBP_BREACH_API_URL = 'https://haveibeenpwned.com/api/v3';

export async function checkEmailBreaches(email: string, apiKey: string): Promise<any[]> {
    if (!apiKey) {
        return [];
    }

    try {
        const request = net.request({
            method: 'GET',
            url: `${HIBP_BREACH_API_URL}/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`,
            headers: {
                'hibp-api-key': apiKey,
                'User-Agent': 'Vigil Password Manager'
            }
        });

        return new Promise((resolve, reject) => {
            let data = '';

            request.on('response', (response) => {
                if (response.statusCode === 404) {
                    resolve([]); // No breaches found
                    return;
                }

                if (response.statusCode !== 200) {
                    reject(new Error('Failed to check email breach status'));
                    return;
                }

                response.on('data', (chunk) => {
                    data += chunk;
                });

                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            request.on('error', (error) => {
                reject(error);
            });

            request.end();
        });
    } catch (error) {
        console.error('Error checking email breach status:', error);
        throw error;
    }
}