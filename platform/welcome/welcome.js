import { ensureSetup } from '../setup.js';

const status = document.getElementById('setup');

ensureSetup().then(() => {
    status.textContent = 'Фильтры настроены, включая RU AdList для русских сайтов.';
    status.dataset.state = 'ok';
}).catch(error => {
    // Не страшно: попап повторит настройку при первом открытии.
    status.textContent = 'Фильтры не удалось донастроить сейчас — это произойдёт, когда вы откроете меню расширения.';
    status.dataset.state = 'error';
    console.warn('ygab setup', error);
});
