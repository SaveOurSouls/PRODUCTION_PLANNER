import type {Metadata} from 'next';
import '../ui/styles.css';
import '@xyflow/react/dist/style.css';
export const metadata:Metadata={title:'Поток — планирование производства',description:'Маршруты, ресурсы и производственные задания'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="ru"><body>{children}</body></html>;}
