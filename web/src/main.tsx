import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import { Embed } from './embed/Embed';
import { App } from './ui/App';

const embed = location.pathname.replace(/\/+$/, '') === '/embed';
render(embed ? <Embed /> : <App />, document.getElementById('app')!);
